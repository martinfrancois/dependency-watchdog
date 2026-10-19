import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

import { statePath } from "./config.ts";
import { defaultRunner, gh, GH_EXEC_OPTIONS, type Runner } from "./github.ts";

/**
 * Clears dependency update threads from the GitHub notification inbox.
 *
 * Renovate opens, rebases and merges pull requests all day, and every one of those lands in the
 * inbox of everyone watching the repository, as does each release a merge publishes. GitHub can
 * only filter watched activity by event type, never by author, so muting it would also mute pull
 * requests from people. Marking the threads done after they arrive is the only way to keep one
 * without the other.
 */

/** Authors whose pull requests, and the releases those pull requests publish, are cleared. */
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
 * `cleared` maps a thread id to the updated_at it had when it was cleared. The listing has to ask
 * for read threads too, since opening a pull request or its email marks the thread read without
 * removing it from the inbox, and GitHub's listing then also returns threads already marked done.
 * Remembering what was cleared is what stops every poll from looking them all up again.
 *
 * `mentioned` maps a thread id to when it last carried a mention. A thread's reason only reflects
 * its latest event, so a Renovate rebase after a mention would otherwise make the mention look
 * like routine activity.
 */
export type SweepState = {
  lastModified?: string;
  nextPollAt?: number;
  listedAt?: number;
  cleared?: Record<string, string>;
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

/**
 * Who opened the pull request behind a thread: the pull request itself, or for a release, the pull
 * request that merged its tagged commit. Null for anything else, or when it no longer exists.
 */
export async function openedBy(thread: Thread, runner: Runner = defaultRunner): Promise<string | null> {
  const url = thread.subject.url;
  if (url === null) return null;
  try {
    if (thread.subject.type === "PullRequest") {
      return (await gh<{ user?: { login?: string } }>(url, { runner })).user?.login ?? null;
    }
    if (thread.subject.type !== "Release") return null;
    const repo = `repos/${thread.repository.full_name}`;
    const { tag_name: tag } = await gh<{ tag_name: string }>(url, { runner });
    const { sha } = await gh<{ sha: string }>(`${repo}/commits/${encodeURIComponent(tag)}`, { runner });
    const pulls = await gh<{ user?: { login?: string } }[]>(`${repo}/commits/${sha}/pulls`, { runner });
    const logins = pulls.flatMap((p) => p.user?.login ?? []);
    return logins.find((login) => AUTHORS.has(login)) ?? logins[0] ?? null;
  } catch (error) {
    if (isGone(error)) return null;
    throw error;
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
 * updated since the previous one, plus one lookup per thread not decided before.
 *
 * A lookup that fails is reported and the rest of the threads are still handled, so one repository
 * the token cannot read does not leave the whole inbox uncleared.
 */
export async function sweep({
  state,
  now = Date.now(),
  dryRun = false,
  fetch = defaultFetch,
  runner = defaultRunner,
  log = console.log,
}: {
  state: SweepState;
  now?: number;
  dryRun?: boolean;
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
  const cleared = Object.fromEntries(Object.entries(state.cleared ?? {})
    .filter(([, updated]) => since === undefined || Date.parse(updated) >= since));
  const mentioned = Object.fromEntries(Object.entries(state.mentioned ?? {})
    .filter(([, at]) => now - at < MENTION_KEEP_MS));
  const done: Thread[] = [];
  const errors: string[] = [];
  for (const thread of threads) {
    if (KEEP_REASONS.has(thread.reason)) mentioned[thread.id] = now;
    if (mentioned[thread.id] !== undefined || cleared[thread.id] === thread.updated_at) continue;
    let author: string | null;
    try {
      author = await openedBy(thread, runner);
    } catch (error) {
      errors.push(`${thread.repository.full_name} ${thread.subject.title}: ${(error as Error).message}`);
      continue;
    }
    if (author === null || !AUTHORS.has(author)) continue;
    if (!dryRun) await markDone(thread.id, runner);
    cleared[thread.id] = thread.updated_at;
    done.push(thread);
    const number = thread.subject.url?.split("/").pop();
    log(`${dryRun ? "would clear" : "cleared"} ${thread.repository.full_name} ${thread.subject.type} ${number} (${thread.reason}) ${thread.subject.title}`);
  }
  return { polled: true, cleared: done, errors, state: { ...polled, listedAt: now, cleared, mentioned } };
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
  const report = await sweep({ state: dryRun ? {} : loadSweepState(), dryRun });
  if (!dryRun) saveSweepState(report.state);
  if (report.errors.length > 0) throw new Error(`${report.errors.length} lookups failed:\n${report.errors.join("\n")}`);
}
