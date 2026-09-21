import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { CheckRun, PullRequest, Commit } from "./types.ts";

const execFileAsync = promisify(execFile);

/**
 * How a command is executed. Injectable so the API-shaping code above can be tested without
 * spawning gh, which would need credentials and a network.
 */
export type Runner = (cmd: string, args: string[]) => Promise<{ stdout: string }>;

const defaultRunner: Runner = (cmd, args) =>
  execFileAsync(cmd, args, { maxBuffer: 64 * 1024 * 1024, timeout: 30_000 });

/**
 * Call the GitHub API through the `gh` CLI.
 *
 * gh is already authenticated on this machine and refreshes its own token, so there is no PAT to
 * store, rotate, or leak into this repository. If that auth ever lapses, every call here throws,
 * the run aborts before pinging healthchecks.io, and the dead-man's switch fires. That is the
 * intended behaviour: a blind watchdog must not look healthy.
 */
export async function gh<T = unknown>(
  endpoint: string,
  {
    paginate = false,
    runner = defaultRunner,
  }: { paginate?: boolean; runner?: Runner } = {},
): Promise<T> {
  const args = ["api", endpoint, "--cache", "0"];
  if (paginate) args.push("--paginate", "--slurp");
  const { stdout } = await runner("gh", args);
  const parsed = JSON.parse(stdout);
  // --slurp wraps each page in an array; flatten so callers see one list.
  return (paginate && Array.isArray(parsed) ? parsed.flat() : parsed) as T;
}

/** Fetch a file's decoded contents, or null when it does not exist on that ref. */
export async function fileContents(
  repo: string,
  filePath: string,
  ref = "HEAD",
  runner: Runner = defaultRunner,
): Promise<string | null> {
  try {
    const res = await gh<{ content: string }>(
      `repos/${repo}/contents/${filePath}?ref=${encodeURIComponent(ref)}`,
      { runner },
    );
    return Buffer.from(res.content, "base64").toString("utf8");
  } catch (error) {
    if (/\b404\b/.test((error as Error).message)) return null;
    throw error;
  }
}

export async function openPullRequests(
  repo: string,
  runner: Runner = defaultRunner,
): Promise<PullRequest[]> {
  return gh<PullRequest[]>(`repos/${repo}/pulls?state=open&per_page=100`, {
    paginate: true,
    runner,
  });
}

/** Combined status for a ref: the rollup GitHub shows on the PR. */
type RawCheck = { name: string; conclusion: string | null; started_at?: string; completed_at?: string; steps?: unknown[]; html_url?: string };
type RawStatus = { context: string; state: string; target_url?: string };

export async function checkStatus(
  repo: string,
  sha: string,
  runner: Runner = defaultRunner,
): Promise<CheckRun[]> {
  const [checks, status] = await Promise.all([
    gh<{ check_runs: RawCheck[] }[]>(
      `repos/${repo}/commits/${sha}/check-runs?per_page=100&filter=latest`,
      { runner, paginate: true },
    ),
    gh<{ statuses: RawStatus[] }[]>(`repos/${repo}/commits/${sha}/status?per_page=100`, {
      runner, paginate: true,
    }),
  ]);
  const pages = <T>(value: T | T[]): T[] => Array.isArray(value) ? value : [value];
  const runs = toCheckRuns(
    pages(checks).flatMap((page) => page.check_runs),
    pages(status).flatMap((page) => page.statuses),
  );
  // Check runs do not include job steps. Fetch them before excluding a short failure.
  for (const run of runs) {
    if (run.conclusion !== "failure" || run.steps !== undefined) continue;
    const job = run.url?.match(/\/actions\/runs\/\d+\/job\/(\d+)$/);
    if (!job || !run.started || !run.completed) continue;
    const duration = Date.parse(run.completed) - Date.parse(run.started);
    if (duration < 0 || duration >= 30_000) continue;
    const detail = await gh<{ steps: unknown[] }>(`repos/${repo}/actions/jobs/${job[1]}`, { runner });
    if (Array.isArray(detail.steps)) run.steps = detail.steps.length;
  }
  return runs;
}

/**
 * Normalise the two shapes GitHub reports check results in.
 *
 * Split out from the network call because this mapping is where `steps` comes from, and `steps`
 * is what tells a real failure apart from a job that never started.
 */
export function toCheckRuns(
  checkRuns: RawCheck[],
  statuses: RawStatus[],
): CheckRun[] {
  const runs: CheckRun[] = (checkRuns || []).map((r) => ({
    name: r.name,
    conclusion: r.conclusion,
    ...(r.started_at === undefined ? {} : { started: r.started_at }),
    ...(r.completed_at === undefined ? {} : { completed: r.completed_at }),
    ...(r.steps === undefined ? {} : { steps: r.steps.length }),
    ...(r.html_url === undefined ? {} : { url: r.html_url }),
  }));
  const latest = new Map<string, RawStatus>();
  for (const status of statuses) {
    if (!latest.has(status.context)) latest.set(status.context, status);
  }
  const legacy: CheckRun[] = [...latest.values()].map((s) => ({
    name: s.context,
    conclusion: s.state === "error" ? "failure" : s.state,
    ...(s.target_url === undefined ? {} : { url: s.target_url }),
  }));
  return [...runs, ...legacy];
}

/**
 * Distinguish a real CI failure from the account-level billing block.
 *
 * A blocked job is reported as `failure` with zero steps and a runtime of a couple of seconds,
 * because it never started. Alerting on those would mean alerting on every check in every private
 * repository for as long as billing is unresolved, which would train the channel to be ignored.
 */
export function isBillingBlocked(run: CheckRun): boolean {
  if (run.conclusion !== "failure" || run.steps !== 0) return false;
  if (!run.started || !run.completed) return false;
  const seconds = (Date.parse(run.completed) - Date.parse(run.started)) / 1000;
  return seconds >= 0 && seconds < 30;
}

/**
 * Recent commits on a branch, newest first.
 *
 * The author login is what matters here: a Renovate commit that reached the default branch is
 * identified by who wrote it, not by parsing its message.
 */
export async function recentCommits(
  repo: string,
  branch: string,
  limit = 20,
  runner: Runner = defaultRunner,
): Promise<Commit[]> {
  type Raw = {
    sha: string;
    html_url: string;
    commit: { message: string; committer?: { date?: string } };
    author?: { login?: string } | null;
  };
  const raw = await gh<Raw[]>(
    `repos/${repo}/commits?sha=${encodeURIComponent(branch)}&per_page=${limit}`,
    { runner },
  );
  return (raw || []).map((c) => ({
    sha: c.sha,
    message: c.commit.message.split("\n")[0] ?? "",
    author: c.author?.login ?? null,
    date: c.commit.committer?.date ?? "",
    url: c.html_url,
  }));
}

/**
 * Whether the platform itself requires a branch to be up to date before merging.
 *
 * Where it does, the base that was checked is always the base that lands, so a dependency update
 * cannot break the default branch by merging green against a stale base. Repositories that turn
 * this off trade that guarantee for not spending a CI run on every rebase, and it is exactly those
 * that need watching instead.
 *
 * Errors resolve to false, which means "watch it". Failing towards checking is the safe direction:
 * the cost is one extra API call, where the cost of wrongly skipping is a broken branch nobody
 * hears about.
 */
export async function strictChecksRequired(
  repo: string,
  runner: Runner = defaultRunner,
): Promise<boolean> {
  type Ruleset = { id: number };
  type Full = {
    rules?: {
      type: string;
      parameters?: { strict_required_status_checks_policy?: boolean };
    }[];
  };
  try {
    const list = await gh<Ruleset[]>(`repos/${repo}/rulesets`, { runner });
    for (const { id } of list || []) {
      const full = await gh<Full>(`repos/${repo}/rulesets/${id}`, { runner });
      for (const rule of full.rules || []) {
        if (rule.type !== "required_status_checks") continue;
        if (rule.parameters?.strict_required_status_checks_policy === true) return true;
      }
    }
  } catch {
    return false;
  }
  return false;
}

/**
 * Whether the repository commits a lockfile at all, anywhere in the tree.
 *
 * A repository with no lockfile has nothing for lockFileMaintenance to refresh, so the absence of
 * refresh commits is correct rather than a fault. Asking GitHub is better than a per-repository
 * setting: a repository that gains or loses a lockfile changes the answer without anyone
 * remembering to update a config file.
 *
 * An API error or truncated tree fails the check so missing coverage is visible.
 */
export async function hasLockfile(repo: string, runner: Runner = defaultRunner): Promise<boolean> {
  const LOCKFILES =
    /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lock|bun\.lockb|Cargo\.lock|poetry\.lock|uv\.lock|composer\.lock|Gemfile\.lock|gradle\.lockfile)$/;
  const tree = await gh<{ tree: { path: string }[]; truncated?: boolean }>(
    `repos/${repo}/git/trees/HEAD?recursive=1`, { runner },
  );
  if (tree.truncated) throw new Error(`Incomplete repository tree for ${repo}`);
  return tree.tree.some((e) => LOCKFILES.test(e.path));
}
