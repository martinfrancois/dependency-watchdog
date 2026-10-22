import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

import { loadSettings, statePath } from "./config.ts";
import { defaultRunner, gh, GH_EXEC_OPTIONS, type Runner } from "./github.ts";
import { PRUNE_BRANCH_PREFIX } from "./prune.ts";

/**
 * Clears automated threads in the reader's own repositories from the GitHub notification inbox.
 *
 * Renovate opens, rebases and merges pull requests all day, and every one of those lands in the
 * inbox of everyone watching the repository, as does each release-please update, each release a
 * merge publishes, and the activity on pull requests agents open as the reader. GitHub can only
 * filter watched activity by event type, never by author, so muting it would also mute pull
 * requests from people. Marking the threads done after they arrive is the only way to keep one
 * without the other.
 */

/** Dependency bots whose pull requests, and the releases their merges publish, are cleared. */
const AUTHORS = new Set(["renovate[bot]"]);

/**
 * Reasons that keep a thread in the inbox even on a dependency pull request. A mention is a person
 * asking the reader something, which is the one thing on these threads worth seeing.
 */
const KEEP_REASONS = new Set(["mention", "team_mention"]);

/** GitHub asks for this many seconds between polls unless X-Poll-Interval says otherwise. */
const DEFAULT_POLL_SECONDS = 60;

/**
 * How far before the previous listing the next one starts. Last-Modified trailed the listing by
 * about 20 seconds when probed, so a listing that started exactly at the previous one could miss a
 * thread GitHub had not counted yet.
 */
const SINCE_MARGIN_MS = 10 * 60_000;

/** How long a thread that carried a mention is protected after its last mention. */
const MENTION_KEEP_MS = 90 * 86_400_000;

export type Thread = {
  id: string;
  reason: string;
  updated_at: string;
  subject: { type: string; title: string; url: string | null };
  repository: { full_name: string };
};

/**
 * Where the last poll left off.
 *
 * `decided` maps a thread id to the updated_at it had when the sweep last looked it up, whether it
 * was cleared or kept. The listing has to ask for read threads too, since opening a pull request or
 * its email marks the thread read without removing it from the inbox, and GitHub's listing then
 * also returns threads already marked done. Remembering every decision is what stops each poll
 * from looking up the same threads again while they stay inside the listing window.
 *
 * `mentioned` maps a thread id to when it last carried a mention. A thread's reason only reflects
 * its latest event, so a Renovate rebase after a mention would otherwise make the mention look
 * like routine activity.
 */
export type SweepState = {
  lastModified?: string;
  nextPollAt?: number;
  listedAt?: number;
  decided?: Record<string, string>;
  mentioned?: Record<string, number>;
};

export type Response = { status: number; headers: Map<string, string>; body: string };

/** Fetches one endpoint and returns the response even for a 304. Injectable for tests. */
export type Fetch = (endpoint: string, headers: Record<string, string>) => Promise<Response>;

/** Parse `gh api -i` output: a status line, headers, a blank line, then the body. */
export function parseResponse(output: string): Response {
  const split = output.search(/\r?\n\r?\n/);
  const head = split === -1 ? output : output.slice(0, split);
  const body = split === -1 ? "" : output.slice(split).replace(/^\r?\n\r?\n/, "");
  const [statusLine = "", ...lines] = head.split(/\r?\n/);
  const status = Number(/^HTTP\/[\d.]+ (\d{3})/.exec(statusLine)?.[1]);
  if (!Number.isInteger(status)) throw new Error(`Unexpected gh output: ${statusLine.slice(0, 80)}`);
  const headers = new Map<string, string>();
  for (const line of lines) {
    const colon = line.indexOf(":");
    if (colon > 0) headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
  }
  return { status, headers, body };
}

/**
 * Turn one gh run into a response. gh exits non-zero on a 304 but still prints the status line, so
 * a 304 is the only failed exit that counts as an answer. Any other error, or output that is not
 * an HTTP response, fails the run.
 */
export function interpret(endpoint: string, error: Error | null, stdout: string, stderr: string): Response {
  const failure = () => new Error(`gh api ${endpoint}: ${stderr.trim() || error?.message}`);
  let response: Response;
  try {
    response = parseResponse(stdout);
  } catch (parseError) {
    throw error ? failure() : parseError;
  }
  if (error && response.status !== 304) throw failure();
  return response;
}

const defaultFetch: Fetch = (endpoint, headers) =>
  new Promise((resolve, reject) => {
    const args = ["api", "-i", endpoint, "--cache", "0"];
    for (const [name, value] of Object.entries(headers)) args.push("-H", `${name}: ${value}`);
    execFile("gh", args, GH_EXEC_OPTIONS, (error, stdout, stderr) => {
      try {
        resolve(interpret(endpoint, error, stdout, stderr));
      } catch (failure) {
        reject(failure);
      }
    });
  });

/** gh reports HTTP failures as "(HTTP 404)". Matching that, not a bare number, keeps PR #404 out. */
const isGone = (error: unknown): boolean => /\(HTTP (404|410)\)/.test((error as Error).message);

type Pull = {
  user?: { login?: string; type?: string };
  head?: { ref?: string };
  state?: "open" | "closed";
  closed_at?: string | null;
};
/** An issue comment, review or review comment. Reviews carry submitted_at instead of created_at. */
type Comment = {
  user?: { login?: string; type?: string } | null;
  body?: string | null;
  created_at?: string;
  submitted_at?: string | null;
};

const isDependencyBot = (pr: Pull): boolean => AUTHORS.has(pr.user?.login ?? "");

/**
 * release-please opens its pull requests from branches named release-please--branches--<base>, for
 * example release-please--branches--main--components--<name>.
 */
const isReleasePleasePr = (pr: Pull): boolean =>
  pr.user?.type === "Bot" && (pr.head?.ref?.startsWith("release-please--") ?? false);

/**
 * What automation a thread in one of the reader's repositories comes from:
 * - "renovate": a pull request Renovate opened.
 * - "release-pr": a release-please pull request, which picks up every merge, Renovate's included.
 * - "prune": a pull request the prune job opened as the reader, open or closed.
 * - "release": a release a bot published for the merge of a Renovate or release-please pull
 *   request, or of one the reader opened.
 * - "own-closed": a closed pull request the reader opened that no other person has commented on or
 *   reviewed since it closed. Agents working as the reader open most of these, and their merges and
 *   the review bots that comment afterwards fill the inbox.
 * Other repositories are never classified, because there the same threads are someone else's work,
 * such as an upstream release that ships the reader's fix.
 */
export type Origin = "renovate" | "release-pr" | "prune" | "release" | "own-closed";

/** A thread's origin, with the pull request's comments when deciding it already fetched them. */
export type Classified = { origin: Origin; comments?: Comment[] };

/** Facts about the reader, looked up at most once per run and only when a thread needs them. */
export type Reader = { login: () => Promise<string>; owns: (repo: string) => Promise<boolean> };

/**
 * A Reader backed by gh. The reader's repositories are those of the listed owners, or of the
 * reader's own account when none are listed. A failed lookup is forgotten, so it does not fail
 * every later thread.
 */
export function reader(owners: string[] = [], runner: Runner = defaultRunner): Reader {
  let value: Promise<string> | undefined;
  const login = () => (value ??= gh<{ login: string }>("user", { runner }).then((u) => u.login)
    .catch((error: unknown) => { value = undefined; throw error; }));
  const listed = new Set(owners.map((owner) => owner.toLowerCase()));
  return {
    login,
    owns: async (repo) => {
      const owner = repo.split("/")[0]!.toLowerCase();
      return listed.size > 0 ? listed.has(owner) : owner === (await login()).toLowerCase();
    },
  };
}

/**
 * Classify a thread, or null when it comes from a person, is in someone else's repository, or no
 * longer exists. See Origin. The repository is checked before anything is looked up.
 */
export async function classify(thread: Thread, me: Reader, runner: Runner = defaultRunner): Promise<Classified | null> {
  const url = thread.subject.url;
  const repo = thread.repository.full_name;
  if (url === null || !["PullRequest", "Release"].includes(thread.subject.type) || !await me.owns(repo)) return null;
  try {
    if (thread.subject.type === "PullRequest") {
      const pr = await gh<Pull>(url, { runner });
      if (isDependencyBot(pr)) return { origin: "renovate" };
      if (isReleasePleasePr(pr)) return { origin: "release-pr" };
      // The prune pushes with the reader's gh token, so its pull requests are the reader's own.
      if (pr.head?.ref?.startsWith(PRUNE_BRANCH_PREFIX)) return pr.user?.login === await me.login() ? { origin: "prune" } : null;
      if (pr.state !== "closed" || !pr.closed_at) return null;
      const login = await me.login();
      if (pr.user?.login !== login) return null;
      const comments = await pullComments(repo, url, runner);
      return answeredSince(comments, login, pr.closed_at) ? null : { origin: "own-closed", comments };
    }
    const release = await gh<{ tag_name: string; author?: { type?: string } | null }>(url, { runner });
    if (release.author?.type !== "Bot") return null;
    const { sha } = await gh<{ sha: string }>(`repos/${repo}/commits/${encodeURIComponent(release.tag_name)}`, { runner });
    const pulls = await gh<Pull[]>(`repos/${repo}/commits/${sha}/pulls`, { runner });
    if (pulls.some((p) => isDependencyBot(p) || isReleasePleasePr(p))) return { origin: "release" };
    if (pulls.length === 0) return null;
    const login = await me.login();
    return pulls.some((p) => p.user?.login === login) ? { origin: "release" } : null;
  } catch (error) {
    if (isGone(error)) return null;
    throw error;
  }
}

/** Every issue comment, review and review comment on a pull request. */
async function pullComments(repo: string, pullUrl: string, runner: Runner): Promise<Comment[]> {
  const number = pullUrl.split("/").pop();
  const lists = await Promise.all([`repos/${repo}/issues/${number}/comments`, `${pullUrl}/reviews`, `${pullUrl}/comments`]
    .map((endpoint) => gh<Comment[]>(`${endpoint}?per_page=100`, { paginate: true, runner })));
  return lists.flat();
}

/** Agents comment as the reader, so the reader's own comments are not a person to answer. */
const isPersonOtherThan = (comment: Comment, login: string): boolean =>
  comment.user?.type !== "Bot" && comment.user?.login !== login;

/**
 * Whether another person commented or reviewed at or after a pull request closed. A comment with
 * no readable date counts, so the thread is kept rather than lost.
 */
export function answeredSince(comments: Comment[], login: string, closedAt: string): boolean {
  const closed = Date.parse(closedAt);
  return comments.some((c) => {
    if (!isPersonOtherThan(c, login)) return false;
    const at = Date.parse(c.submitted_at ?? c.created_at ?? "");
    return Number.isNaN(at) || at >= closed;
  });
}

/**
 * Whether another person, not a bot or the reader, mentions the reader or a team. Bots write the
 * reader's handle into changelogs and reviews, and GitHub gives such a thread the reason "mention"
 * too, so the reason alone cannot tell a bot's mention from a person's. A team mention is matched
 * as any @owner/name, which also matches scoped package names and so errs towards keeping.
 */
export function personMentions(comments: Comment[], login: string): boolean {
  const handle = login.replace(/[^A-Za-z0-9-]/g, "");
  // The lookarounds keep e-mail addresses, URL paths and @reader-bot from counting as @reader.
  const mention = new RegExp(`(?<![A-Za-z0-9_./-])@(${handle}(?![A-Za-z0-9-])|[A-Za-z0-9-]+/[A-Za-z0-9_.-]+)`, "i");
  return comments.some((c) => isPersonOtherThan(c, login) && mention.test(c.body ?? ""));
}

/**
 * Whether a mention in the last 90 days keeps an automated thread in the inbox. On a Renovate pull
 * request any mention does. A release cannot be commented on, so a mention there is in notes a bot
 * wrote, such as release-please crediting the reader. On a release-please pull request the
 * changelog mentions the reader, and on the reader's own pull requests, prune ones included, review
 * bots do, so there only another person's mention counts. A pull request deleted meanwhile has none.
 */
async function mentionKeeps(
  thread: Thread,
  { origin, comments }: Classified,
  mentionedAt: number | undefined,
  me: Reader,
  runner: Runner,
): Promise<boolean> {
  if (mentionedAt === undefined) return false;
  switch (origin) {
    case "renovate": return true;
    case "release": return false;
    case "release-pr":
    case "prune":
    case "own-closed": {
      let list = comments;
      try {
        list ??= await pullComments(thread.repository.full_name, thread.subject.url as string, runner);
      } catch (error) {
        if (isGone(error)) return false;
        throw error;
      }
      return personMentions(list, await me.login());
    }
  }
}

export function notificationStatePath(): string {
  return path.join(path.dirname(statePath()), "notifications.json");
}

/** An unreadable state file costs one full listing, so it resets rather than failing. */
export function loadSweepState(file = notificationStatePath()): SweepState {
  try {
    const state = JSON.parse(readFileSync(file, "utf8")) as SweepState;
    return state && typeof state === "object" && !Array.isArray(state) ? state : {};
  } catch {
    return {};
  }
}

export function saveSweepState(state: SweepState, file = notificationStatePath()): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(`${file}.tmp`, JSON.stringify(state), { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
}

export type SweepReport = { polled: boolean; cleared: Thread[]; errors: string[]; state: SweepState };

/**
 * One poll of the inbox.
 *
 * The first request is conditional on the Last-Modified value of the previous one. GitHub answers a
 * 304 when nothing arrived, and a 304 does not count against the rate limit, so polling every
 * minute costs nothing while the inbox is quiet. A changed inbox costs a listing of the threads
 * updated since the previous one, plus a few lookups for each thread in the reader's repositories
 * not decided before. Threads elsewhere cost none.
 *
 * A lookup that fails is reported and the rest of the threads are still handled, so one repository
 * the token cannot read does not leave the whole inbox uncleared.
 */
export async function sweep({
  state,
  now = Date.now(),
  dryRun = false,
  owners = [],
  fetch = defaultFetch,
  runner = defaultRunner,
  log = console.log,
}: {
  state: SweepState;
  now?: number;
  dryRun?: boolean;
  owners?: string[];
  fetch?: Fetch;
  runner?: Runner;
  log?: (line: string) => void;
}): Promise<SweepReport> {
  if (state.nextPollAt !== undefined && now < state.nextPollAt) {
    return { polled: false, cleared: [], errors: [], state };
  }
  const conditional: Record<string, string> = state.lastModified ? { "If-Modified-Since": state.lastModified } : {};
  const first = await fetch("notifications?all=true&per_page=1", conditional);
  const interval = Number(first.headers.get("x-poll-interval")) || DEFAULT_POLL_SECONDS;
  const lastModified = first.headers.get("last-modified") ?? state.lastModified;
  const polled: SweepState = { ...state, ...(lastModified === undefined ? {} : { lastModified }), nextPollAt: now + interval * 1000 };
  if (first.status === 304) return { polled: true, cleared: [], errors: [], state: polled };
  if (first.status !== 200) throw new Error(`GitHub answered ${first.status} for notifications`);

  const since = state.listedAt === undefined ? undefined : state.listedAt - SINCE_MARGIN_MS;
  const query = since === undefined ? "" : `&since=${new Date(since).toISOString()}`;
  const threads = await gh<Thread[]>(`notifications?all=true&per_page=50${query}`, { paginate: true, runner });

  // A thread last updated before this listing's start cannot come back unchanged, so its entry goes.
  const decided = Object.fromEntries(Object.entries(state.decided ?? {})
    .filter(([, updated]) => since === undefined || Date.parse(updated) >= since));
  const mentioned = Object.fromEntries(Object.entries(state.mentioned ?? {})
    .filter(([, at]) => now - at < MENTION_KEEP_MS));
  const done: Thread[] = [];
  const errors: string[] = [];
  const me = reader(owners, runner);
  for (const thread of threads) {
    if (KEEP_REASONS.has(thread.reason)) mentioned[thread.id] = now;
    if (decided[thread.id] === thread.updated_at) continue;
    let classified: Classified | null;
    let keep: boolean;
    try {
      classified = await classify(thread, me, runner);
      keep = classified !== null && await mentionKeeps(thread, classified, mentioned[thread.id], me, runner);
    } catch (error) {
      errors.push(`${thread.repository.full_name} ${thread.subject.title}: ${(error as Error).message}`);
      continue;
    }
    decided[thread.id] = thread.updated_at;
    if (classified === null || keep) continue;
    if (!dryRun) await markDone(thread.id, runner);
    done.push(thread);
    const number = thread.subject.url?.split("/").pop();
    log(`${dryRun ? "would clear" : "cleared"} ${thread.repository.full_name} ${thread.subject.type} ${number} (${thread.reason}) ${thread.subject.title}`);
  }
  return { polled: true, cleared: done, errors, state: { ...polled, listedAt: now, decided, mentioned } };
}

/** DELETE marks a thread done, which removes it from the inbox until something new happens on it. */
export async function markDone(id: string, runner: Runner = defaultRunner): Promise<void> {
  if (!/^\d+$/.test(id)) throw new Error(`Unexpected notification thread id ${id}`);
  await runner("gh", ["api", "-X", "DELETE", `notifications/threads/${id}`, "--silent"]);
}

/**
 * A dry run starts from empty state, so it lists the whole inbox instead of waiting for a change.
 * State is saved before lookup errors fail the run, so the threads that were cleared stay cleared.
 */
export async function runSweep(argv = process.argv): Promise<void> {
  const dryRun = argv.includes("--dry-run");
  const owners = loadSettings().notificationOwners;
  const report = await sweep({ state: dryRun ? {} : loadSweepState(), dryRun, owners });
  if (!dryRun) saveSweepState(report.state);
  if (report.errors.length > 0) throw new Error(`${report.errors.length} lookups failed:\n${report.errors.join("\n")}`);
}
