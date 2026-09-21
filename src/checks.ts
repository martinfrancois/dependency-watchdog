import {
  checkStatus as realCheckStatus,
  fileContents as realFileContents,
  gh as realGh,
  isBillingBlocked,
  openPullRequests as realOpenPullRequests,
  hasLockfile as realHasLockfile,
  recentCommits as realRecentCommits,
  strictChecksRequired as realStrictChecksRequired,
} from "./github.ts";
import { workspaceFileFor } from "./config.ts";
import type { CheckRun, Commit, Finding, PullRequest, Settings } from "./types.ts";

/**
 * The outside world, injectable.
 *
 * Every check reaches GitHub or the npm registry. Passing those in rather than importing them
 * directly is what makes the decision logic testable without a network, and the decision logic is
 * the part that decides whether you get woken up.
 */
export type Deps = {
  openPullRequests: (repo: string) => Promise<PullRequest[]>;
  checkStatus: (repo: string, sha: string) => Promise<CheckRun[]>;
  gh: <T>(endpoint: string) => Promise<T>;
  fileContents: (repo: string, file: string) => Promise<string | null>;
  publishedAt: (entry: string) => Promise<number | null>;
  recentCommits: (repo: string, branch: string, limit?: number) => Promise<Commit[]>;
  strictChecksRequired: (repo: string) => Promise<boolean>;
  hasLockfile: (repo: string) => Promise<boolean>;
};

export const defaultDeps: Deps = {
  openPullRequests: realOpenPullRequests,
  checkStatus: realCheckStatus,
  gh: (endpoint) => realGh(endpoint),
  fileContents: (repo, file) => realFileContents(repo, file),
  publishedAt: (entry) => publishedAt(entry),
  recentCommits: (repo, branch, limit) => realRecentCommits(repo, branch, limit),
  strictChecksRequired: (repo) => realStrictChecksRequired(repo),
  hasLockfile: (repo) => realHasLockfile(repo),
};

const HOUR = 3600_000;
const DAY = 24 * HOUR;

const ageMs = (iso: string): number => Date.now() - Date.parse(iso);
const days = (ms: number): number => Math.floor(ms / DAY);
const hours = (ms: number): number => Math.floor(ms / HOUR);

const isRenovate = (pr: PullRequest): boolean =>
  pr.head?.ref?.startsWith("renovate/") || pr.user?.login === "renovate[bot]";

/**
 * A security pull request has been open too long.
 *
 * This is the one that matters most. The point of letting a vulnerability fix bypass the cooldown
 * is that it lands immediately; a security pull request sitting open means that promise is quietly
 * not being kept.
 *
 * Both the label and Renovate authorship are required. Matching the title alone matched nineteen
 * unrelated pull requests with words like "CRITICAL" and "vulnerabilities" in them during
 * development, which is precisely the flood that teaches you to ignore a channel.
 */
export async function securityPrsStuck(
  repo: string,
  settings: Settings,
  deps: Deps = defaultDeps,
): Promise<Finding[]> {
  const limit = settings.thresholds.securityPrHours * HOUR;
  const wanted = settings.securityLabels.map((l) => l.toLowerCase());
  const out: Finding[] = [];
  for (const pr of await deps.openPullRequests(repo)) {
    const labels = (pr.labels || []).map((l) => l.name.toLowerCase());
    if (!labels.some((l) => wanted.includes(l)) || !isRenovate(pr)) continue;
    const age = ageMs(pr.created_at);
    if (age < limit) continue;
    out.push({
      failing: (await deps.checkStatus(repo, pr.head.sha)).filter(isRealFailure),
      id: `security-pr:${repo}#${pr.number}`,
      kind: "security PR unmerged",
      repo,
      number: pr.number,
      title: pr.title,
      url: pr.html_url,
      opened: pr.created_at,
      ageText: `${days(age)}d ${hours(age % DAY)}h`,
      threshold: `${settings.thresholds.securityPrHours}h`,
      sha: pr.head.sha,
    });
  }
  return out;
}

/**
 * An old dependency pull request currently has failing checks.
 * The age threshold measures PR age, not continuous failure duration.
 *
 * Checks that never started are excluded. Some CI providers report a blocked or unbilled job as a
 * failure with zero steps and a runtime of seconds; alerting on those would fire for every
 * repository at once and drown the signal.
 */
export async function automergePrsFailing(
  repo: string,
  settings: Settings,
  deps: Deps = defaultDeps,
): Promise<Finding[]> {
  const limit = settings.thresholds.failingPrDays * DAY;
  const out: Finding[] = [];
  for (const pr of await deps.openPullRequests(repo)) {
    if (!isRenovate(pr)) continue;
    const age = ageMs(pr.created_at);
    if (settings.checks.securityPrs && isSecurity(pr, settings) && age >= settings.thresholds.securityPrHours * HOUR) continue;
    if (age < limit) continue;

    const runs = await deps.checkStatus(repo, pr.head.sha);
    const failing = runs.filter(
      (r) => isRealFailure(r),
    );
    if (!failing.length) continue;

    out.push({
      id: `automerge-stuck:${repo}#${pr.number}`,
      kind: "dependency PR failing",
      sha: pr.head.sha,
      repo,
      number: pr.number,
      title: pr.title,
      url: pr.html_url,
      opened: pr.created_at,
      ageText: `${days(age)}d open`,
      threshold: `${settings.thresholds.failingPrDays}d`,
      failing: failing.slice(0, 3),
    });
  }
  return out;
}

/** An open maintenance PR is evidence of work to land. Missing commits are not. */
export async function refreshMissing(
  repo: string,
  settings: Settings,
  _baselineMs: number | null = null,
  deps: Deps = defaultDeps,
): Promise<Finding[]> {
  if (!(await deps.hasLockfile(repo))) return [];
  const out: Finding[] = [];
  for (const pr of await deps.openPullRequests(repo)) {
    if (!isRenovate(pr) || !isMaintenance(pr)) continue;
    const age = ageMs(pr.created_at);
    if (age < settings.thresholds.noRefreshDays * DAY) continue;
    const runs = await deps.checkStatus(repo, pr.head.sha);
    // The failing-PR check already reports this blocker at its shorter threshold.
    if (settings.checks.failingPrs && age >= settings.thresholds.failingPrDays * DAY && runs.some(isRealFailure)) continue;
    if (settings.checks.securityPrs && isSecurity(pr, settings) && age >= settings.thresholds.securityPrHours * HOUR) continue;
    out.push({
      id: `refresh-stuck:${repo}#${pr.number}`,
      kind: "lockfile maintenance PR unmerged",
      repo, number: pr.number, title: pr.title, url: pr.html_url,
      opened: pr.created_at, sha: pr.head.sha,
      ageText: `${days(age)}d open`, threshold: `${settings.thresholds.noRefreshDays}d`,
      failing: runs.filter(isRealFailure),
    });
  }
  return out;
}

function isSecurity(pr: PullRequest, settings: Settings): boolean {
  return (pr.labels ?? []).some((label) =>
    settings.securityLabels.some((wanted) => wanted.toLowerCase() === label.name.toLowerCase()));
}

function isMaintenance(pr: PullRequest): boolean {
  return /(?:^|\/)lock-file-maintenance(?:$|[-/])/.test(pr.head.ref)
    || /lock\s*file maintenance/i.test(pr.title);
}

/**
 * Cooldown exclusions that should have been pruned.
 *
 * Every entry is meant to be temporary. A list that stops shrinking means the prune is not running,
 * and each stale entry is a package permanently exempt from the cooldown.
 */
export async function staleExclusions(
  repo: string,
  settings: Settings,
  deps: Deps = defaultDeps,
): Promise<Finding[]> {
  const file = workspaceFileFor(settings, repo);
  const text = await deps.fileContents(repo, file);
  if (!text) return [];
  const entries = parseExclusions(text);
  if (!entries.length) return [];

  const cutoff = settings.thresholds.cooldownDays * DAY;
  const stale: string[] = [];
  for (const entry of entries) {
    const published = await deps.publishedAt(entry);
    if (published === null) throw new Error(`Cannot determine release age for ${entry}`);
    if (Date.now() - published >= cutoff) stale.push(entry);
  }
  if (!stale.length) return [];
  return [
    {
      id: `stale-exclusions:${repo}`,
      kind: "cooldown exclusions not pruned",
      repo,
      url: `https://github.com/${repo}/blob/HEAD/${file}`,
      file,
      entries: stale,
      threshold: "matured entries should be removed",
    },
  ];
}

/**
 * Pull `name@version` items out of a minimumReleaseAgeExclude block.
 *
 * Comments and blank lines may appear anywhere inside the block, including directly after the key,
 * which is how these files are usually written. An earlier version required a list item on the very
 * next line and so reported "no exclusions" for every real file, which would have made the prune's
 * safety invariant vacuous and this check blind.
 */
export function parseExclusions(yamlText: string): string[] {
  const lines = yamlText.split("\n");
  const start = lines.findIndex((l) => /^minimumReleaseAgeExclude:\s*$/.test(l));
  if (start === -1) return [];

  const out: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (/^\s+-\s/.test(line)) {
      out.push(line.trim().slice(2).trim().replace(/^["']|["']$/g, ""));
      continue;
    }
    if (/^\s*$/.test(line) || (/^\s*#/.test(line) && !/^\S/.test(line))) continue;
    if (/^\s*#/.test(line)) {
      let look = i + 1;
      while (look < lines.length && /^\s*(#|$)/.test(lines[look] ?? "")) look++;
      if (look < lines.length && /^\s+-\s/.test(lines[look] ?? "")) continue;
      break;
    }
    break;
  }
  return out.filter(Boolean);
}

/** Publish time of `name@version`, or null when it cannot be determined. */
export async function publishedAt(
  entry: string,
  registry = "https://registry.npmjs.org",
): Promise<number | null> {
  const at = entry.lastIndexOf("@");
  if (at <= 0) return null;
  const name = entry.slice(0, at);
  const version = entry.slice(at + 1);
  if (!/^\d/.test(version)) return null;
  try {
    const res = await fetch(`${registry}/${name}`, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) return null;
    const data = (await res.json()) as { time?: Record<string, string> };
    const iso = data.time?.[version];
    return iso ? Date.parse(iso) : null;
  } catch {
    return null;
  }
}

/** How a commit's CI looks right now. `unknown` covers "still running" and "nothing ran". */
export type CommitVerdict = "passing" | "failing" | "unknown";

/**
 * The failing default-branch history contains a dependency commit.
 * This is correlation. The check does not establish which change caused the failure.
 *
 * This exists because private repositories deliberately do not require a branch to be up to date
 * before merging: forcing a rebase would spend another full CI run on every merge, and the risk it
 * removes is small. The accepted trade is that two changes which are each green on their own can
 * land and break the branch together. This check is the other half of that trade, catching it on
 * the default branch instead of preventing it at the door.
 *
 * Strict rulesets do not rule out failures in post-merge workflows or bypassed checks.
 *
 * The rule that keeps this quiet: it judges the branch as it is now, not as it was. A Renovate
 * commit that failed and was then fixed by a later commit produces nothing, because the head is
 * green. Only a failure that reaches the current head, and whose unbroken run of failures includes
 * a Renovate commit, is worth an interruption.
 */
export async function defaultBranchBroken(
  repo: string,
  settings: Settings,
  deps: Deps = defaultDeps,
): Promise<Finding[]> {
  const branch = settings.defaultBranch;
  const WINDOW = 20;
  const commits = await deps.recentCommits(repo, branch, WINDOW);
  if (!commits.length) return [];

  // Walk back from the head while commits are failing. The moment one is green or undecided the
  // run ends, which is what makes a later fix silence this entirely.
  const failing: Commit[] = [];
  let startObserved = false;
  for (const commit of commits) {
    const verdict = await verdictFor(repo, commit.sha, deps);
    if (verdict !== "failing") {
      startObserved = verdict === "passing";
      break;
    }
    failing.push(commit);
  }
  if (!failing.length) return [];

  // The earliest dependency commit is context for investigation, not a proven cause.
  const chronological = [...failing].reverse();
  const culprit = chronological.find(isRenovateCommit);
  if (!culprit) return [];

  // If the run filled the whole window we never saw it begin, so the oldest commit we have is a
  // boundary rather than a cause. Say so, rather than naming it as the commit that broke the
  // branch: a confident wrong attribution sends someone to the wrong commit.
  const suffix = startObserved ? "" : ", start not observed";

  const head = failing[0]!;
  const runs = await deps.checkStatus(repo, head.sha);
  const broken = runs.filter((r) => isRealFailure(r));

  return [
    {
      id: `main-broken:${repo}:${culprit.sha}`,
      kind: "default branch failing after dependency changes",
      repo,
      url: culprit.url,
      title: culprit.message,
      sha: head.sha,
      last: culprit.date,
      threshold:
        `${failing.length}${startObserved ? "" : "+"} commit${failing.length === 1 ? "" : "s"} failing` +
        `${suffix}`,
      brokenSince: chronological,
      failing: broken,
    },
  ];
}

/** A failure that is really a failure, rather than a job the billing block stopped from starting. */
function isRealFailure(run: CheckRun): boolean {
  if (isBillingBlocked(run)) return false;
  return (
    run.conclusion === "failure" ||
    run.conclusion === "timed_out" ||
    run.conclusion === "action_required"
  );
}

/**
 * Decide whether a commit's checks are failing, passing, or not yet answerable.
 *
 * Anything undecided is `unknown` rather than a guess in either direction: a commit whose CI is
 * still running must not be reported as broken, and must not be treated as a green wall that hides
 * an older failure either.
 */
export async function verdictFor(
  repo: string,
  sha: string,
  deps: Deps,
): Promise<CommitVerdict> {
  const runs = await deps.checkStatus(repo, sha);
  const real = runs.filter((r) => !isBillingBlocked(r));
  if (!real.length) return "unknown";
  if (real.some(isRealFailure)) return "failing";
  if (real.every((r) => r.conclusion === "success" || r.conclusion === "neutral" || r.conclusion === "skipped")) {
    return "passing";
  }
  return "unknown";
}

/**
 * Whether a commit on the default branch came from Renovate.
 *
 * The author login is authoritative. The message patterns are a fallback for the case that
 * motivates this whole check: a rebase merge performed by a person or by automation on Renovate's
 * behalf, where the commit lands under a human account but the change is still a dependency bump.
 */
export function isRenovateCommit(commit: Commit): boolean {
  if (commit.author === "renovate[bot]") return true;
  const m = commit.message;
  return (
    /^(chore|fix|build)\(deps[^)]*\):/i.test(m) ||
    /^Update dependency /i.test(m) ||
    /^Lock file maintenance/i.test(m) ||
    /^Pin dependencies/i.test(m)
  );
}
