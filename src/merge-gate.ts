import { execFile } from "node:child_process";
import { promisify } from "node:util";

export type GateEvidence = {
  authenticatedLogin: string; owner: string; head: string; state: string;
  checks: { name: string; state: string; billingBlocked?: boolean }[];
  unresolvedBotThreads: number; botChangesRequested: number;
  botComments: string[]; truncated: boolean;
};
export function evaluateGate(e: GateEvidence, localChecksPassed = false): { allowed: boolean; reasons: string[]; head: string } {
  const reasons: string[] = [];
  if (e.authenticatedLogin.toLowerCase() !== e.owner.toLowerCase()) reasons.push("Only the upstream owner may merge automatically");
  if (e.state !== "OPEN") reasons.push("PR is not open");
  if (e.truncated) reasons.push("Bot review evidence is incomplete");
  if (e.unresolvedBotThreads || e.botChangesRequested) reasons.push("Bot review findings remain unresolved");
  // Comments without structured review state need human or agent inspection before merging.
  if (e.botComments.some((body) => /(?:[1-9]\d*\s+(?:issues?|bugs?|findings?|vulnerabilities)|(?:critical|high|medium)[ -]severity|\[P[0123]\]|❌|potential (?:issue|bug))/i.test(body))) reasons.push("Bot comments contain findings that require review");
  if (!e.checks.some((c) => c.state === "SUCCESS" || (localChecksPassed && c.billingBlocked && c.state === "FAILURE"))) reasons.push("No successful CI checks observed");
  for (const check of e.checks) {
    if (["SUCCESS", "NEUTRAL", "SKIPPED"].includes(check.state)) continue;
    if (check.billingBlocked && localChecksPassed && check.state === "FAILURE") continue;
    reasons.push(`${check.name}: ${check.state}${check.billingBlocked ? "; local CI checks are required" : ""}`);
  }
  return { allowed: reasons.length === 0, reasons, head: e.head };
}
const exec = promisify(execFile);
export type GateRunner = (args: string[]) => Promise<string>;
const gh: GateRunner = async (args) => (await exec("gh", args, { timeout: 30_000, maxBuffer: 8 * 1024 * 1024 })).stdout;
export async function inspectMergeGate(repo: string, number: number, localChecksPassed = false, run: GateRunner = gh): Promise<ReturnType<typeof evaluateGate>> {
  const [owner, name] = repo.split("/");
  if (!owner || !name || !Number.isInteger(number) || number < 1) throw new Error("Expected owner/repo and a PR number");
  const user = JSON.parse(await run(["api", "user"])) as { login: string };
  const pr = JSON.parse(await run(["pr", "view", String(number), "--repo", repo, "--json", "state,headRefOid,statusCheckRollup"])) as { state: string; headRefOid: string; statusCheckRollup: { name?: string; context?: string; status?: string; conclusion?: string; state?: string; detailsUrl?: string }[] };
  const query = `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100){pageInfo{hasNextPage}nodes{isResolved comments(first:100){pageInfo{hasNextPage}nodes{author{login __typename}}}}}reviews(first:100){pageInfo{hasNextPage}nodes{state author{login __typename}}}comments(first:100){pageInfo{hasNextPage}nodes{body author{login __typename}}}}}}`;
  type Actor = { login: string; __typename?: string } | null;
  type Page<T> = { pageInfo: { hasNextPage: boolean }; nodes: T[] };
  const review = (JSON.parse(await run(["api", "graphql", "-f", `query=${query}`, "-f", `owner=${owner}`, "-f", `name=${name}`, "-F", `number=${number}`])) as { data: { repository: { pullRequest: {
    reviewThreads: Page<{ isResolved: boolean; comments: Page<{ author: Actor }> }>;
    reviews: Page<{ state: string; author: Actor }>;
    comments: Page<{ body: string; author: Actor }>;
  } } } }).data.repository.pullRequest;
  const bot = (actor: Actor): boolean => actor?.__typename === "Bot" || Boolean(actor?.login.endsWith("[bot]"));
  const latestReviews = new Map<string, string>();
  for (const r of review.reviews.nodes) if (bot(r.author) && ["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(r.state)) latestReviews.set(r.author!.login, r.state);
  const checks: GateEvidence["checks"] = [];
  for (const c of pr.statusCheckRollup) {
    const state = (c.conclusion || c.state || c.status || "UNKNOWN").toUpperCase();
    let billingBlocked = false;
    const job = c.detailsUrl?.match(/\/actions\/runs\/\d+\/job\/(\d+)$/);
    if (localChecksPassed && state === "FAILURE" && job) {
      const details = JSON.parse(await run(["api", `repos/${repo}/actions/jobs/${job[1]}`])) as { steps?: unknown[]; check_run_url: string };
      if (details.steps?.length === 0 && details.check_run_url) {
        const annotations = JSON.parse(await run(["api", `${details.check_run_url}/annotations`])) as { message: string }[];
        billingBlocked = annotations.some((a) => /(?:billing|spending limit|payments? have failed|included minutes)/i.test(a.message));
      }
    }
    checks.push({ name: c.name ?? c.context ?? "unnamed", state, billingBlocked });
  }
  return evaluateGate({ authenticatedLogin: user.login, owner, head: pr.headRefOid, state: pr.state, checks,
    unresolvedBotThreads: review.reviewThreads.nodes.filter((t) => !t.isResolved && t.comments.nodes.some((c) => bot(c.author))).length,
    botChangesRequested: [...latestReviews.values()].filter((s) => s === "CHANGES_REQUESTED").length,
    botComments: review.comments.nodes.filter((c) => bot(c.author)).map((c) => c.body),
    truncated: review.reviewThreads.pageInfo.hasNextPage || review.reviews.pageInfo.hasNextPage || review.comments.pageInfo.hasNextPage || review.reviewThreads.nodes.some((t) => t.comments.pageInfo.hasNextPage),
  }, localChecksPassed);
}
export async function runMergeGate(run: GateRunner = gh): Promise<void> {
  const [repo, number] = process.argv.slice(2);
  const result = await inspectMergeGate(repo ?? "", Number(number), process.argv.includes("--local-checks-passed"), run);
  console.log(JSON.stringify(result, null, 2));
  if (!result.allowed) process.exitCode = 1;
}
