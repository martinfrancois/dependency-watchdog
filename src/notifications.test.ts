import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { Runner } from "./github.ts";
import {
  answeredSince,
  classify,
  interpret,
  loadSweepState,
  markDone,
  parseResponse,
  personMentions,
  reader,
  saveSweepState,
  sweep,
  type Fetch,
  type Reader,
  type Response,
  type Thread,
} from "./notifications.ts";

const UPDATED = "2026-10-19T13:00:00Z";
const API = "https://api.github.com/";

const thread = (id: string, over: Partial<Thread> = {}): Thread => ({
  id,
  reason: "subscribed",
  updated_at: UPDATED,
  subject: { type: "PullRequest", title: `PR ${id}`, url: `${API}repos/o/r/pulls/${id}` },
  repository: { full_name: "o/r" },
  ...over,
});

const release = (id: string): Thread => thread(id, {
  subject: { type: "Release", title: `Release ${id}`, url: `${API}repos/o/r/releases/${id}` },
});

const pr = (login: string, type = login.endsWith("[bot]") ? "Bot" : "User", ref = "feature") =>
  ({ user: { login, type }, head: { ref } });
const releasePleasePr = pr("github-actions[bot]", "Bot", "release-please--branches--main");
const CLOSED = "2026-10-19T12:00:00Z";
const ownClosed = { ...pr("me"), state: "closed", closed_at: CLOSED };
/** The comment, review and review comment lists of pull request 5. */
const commentRoutes = (issue: unknown[], reviews: unknown[] = [], review: unknown[] = []) => ({
  "repos/o/r/issues/5/comments": issue, "repos/o/r/pulls/5/reviews": reviews, "repos/o/r/pulls/5/comments": review,
});
const comment = (login: string, at: string, body = "", type = login.endsWith("[bot]") ? "Bot" : "User") =>
  ({ user: { login, type }, created_at: at, body });

/**
 * The GitHub objects a release thread resolves through: the release, its tag's commit, and the pull
 * requests that merged that commit.
 */
const releaseRoutes = (id: string, author: { login: string; type: string } | null, pulls: unknown[]) => ({
  [`repos/o/r/releases/${id}`]: { tag_name: `v${id}`, author },
  [`repos/o/r/commits/v${id}`]: { sha: `sha${id}` },
  [`repos/o/r/commits/sha${id}/pulls`]: pulls,
});
const actions = { login: "github-actions[bot]", type: "Bot" };

const response = (status: number, headers: Record<string, string> = {}): Response => ({
  status,
  headers: new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])),
  body: "",
});

/**
 * A fake gh. `routes` maps an endpoint, without the API host or query, to the JSON it returns or
 * the error it throws. The inbox listing returns `threads`, and the authenticated user is "me".
 * Every call is recorded, so tests can assert what was and was not looked up.
 */
function fakeGitHub(threads: Thread[], routes: Record<string, unknown> = {}) {
  const deleted: string[] = [];
  const calls: string[] = [];
  const runner: Runner = async (_cmd, args) => {
    if (args.includes("DELETE")) {
      calls.push(`DELETE ${args[3]}`);
      deleted.push(args[3]!.split("/").pop()!);
      return { stdout: "" };
    }
    const endpoint = args[1]!;
    calls.push(endpoint);
    if (endpoint.startsWith("notifications")) return { stdout: JSON.stringify([threads]) };
    const key = endpoint.replace(API, "").replace(/\?.*$/, "");
    if (key === "user" && !("user" in routes)) return { stdout: JSON.stringify({ login: "me" }) };
    if (!(key in routes)) throw new Error(`gh: Not Found (HTTP 404) for ${key}`);
    const value = routes[key];
    if (value instanceof Error) throw value;
    return { stdout: JSON.stringify(value) };
  };
  const lookups = () => calls.filter((c) => !c.startsWith("notifications") && !c.startsWith("DELETE"));
  return { runner, deleted, calls, lookups };
}

const lastModified = "Mon, 19 Oct 2026 13:28:39 GMT";
const changed: Fetch = async () => response(200, { "Last-Modified": lastModified, "X-Poll-Interval": "60" });
const quiet = () => {};
const me = (owns = true): Reader => ({ login: async () => "me", owns: async () => owns });
const originOf = async (t: Thread, r: Reader, runner: Runner) => (await classify(t, r, runner))?.origin ?? null;

describe("parseResponse", () => {
  test("reads the status, headers and body of a 200", () => {
    const r = parseResponse("HTTP/2.0 200 OK\r\nLast-Modified: Mon, 19 Oct 2026 13:28:39 GMT\r\nX-Poll-Interval: 60\r\n\r\n[]");
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("last-modified"), lastModified);
    assert.equal(r.headers.get("x-poll-interval"), "60");
    assert.equal(r.body, "[]");
  });

  test("reads a 304, which gh reports with a non-zero exit and no body", () => {
    const r = parseResponse("HTTP/2.0 304 Not Modified\nCache-Control: private\n");
    assert.equal(r.status, 304);
    assert.equal(r.body, "");
  });

  test("rejects output that is not an HTTP response", () => {
    assert.throws(() => parseResponse("gh: not logged in"), /Unexpected gh output/);
  });
});

describe("interpret", () => {
  const exit1 = new Error("Command failed: gh api");

  test("a 304 with a failed exit is an answer, not an error", () => {
    assert.equal(interpret("n", exit1, "HTTP/2.0 304 Not Modified\n\n", "gh: HTTP 304").status, 304);
  });

  test("any other failed exit is an error, even with a parseable status", () => {
    assert.throws(() => interpret("n", exit1, "HTTP/2.0 401 Unauthorized\n\n{}", "gh: Bad credentials (HTTP 401)"), /gh api n: gh: Bad credentials/);
  });

  test("a failed exit with no HTTP output reports gh's message", () => {
    assert.throws(() => interpret("n", exit1, "", "gh: not logged in"), /gh api n: gh: not logged in/);
  });

  test("a successful exit with unparseable output is still an error", () => {
    assert.throws(() => interpret("n", null, "garbage", ""), /Unexpected gh output/);
  });

  test("a 200 passes through", () => {
    assert.equal(interpret("n", null, "HTTP/2.0 200 OK\n\n[]", "").body, "[]");
  });
});

describe("originOf", () => {
  test("a Renovate pull request", async () => {
    const gh = fakeGitHub([], { "repos/o/r/pulls/7": pr("renovate[bot]") });
    assert.equal(await originOf(thread("7"), me(), gh.runner), "renovate");
  });

  test("a release-please pull request", async () => {
    const gh = fakeGitHub([], { "repos/o/r/pulls/7": releasePleasePr });
    assert.equal(await originOf(thread("7"), me(), gh.runner), "release-pr");
  });

  test("a pull request from a person, or from another bot, comes from nobody it clears", async () => {
    const gh = fakeGitHub([], {
      "repos/o/r/pulls/7": pr("someone"),
      "repos/o/r/pulls/8": pr("dependabot[bot]"),
      // A person's branch named like release-please's is still a person's pull request.
      "repos/o/r/pulls/9": pr("someone", "User", "release-please--branches--main"),
    });
    for (const id of ["7", "8", "9"]) assert.equal(await originOf(thread(id), me(), gh.runner), null);
  });

  test("a bot's release of a Renovate, release-please or own merge is automated", async () => {
    const gh = fakeGitHub([], {
      ...releaseRoutes("1", actions, [pr("renovate[bot]")]),
      ...releaseRoutes("2", actions, [releasePleasePr]),
      ...releaseRoutes("3", actions, [pr("me")]),
    });
    for (const id of ["1", "2", "3"]) assert.equal(await originOf(release(id), me(), gh.runner), "release", id);
  });

  test("the reader's login is only looked up when no bot's pull request decides it", async () => {
    const gh = fakeGitHub([], releaseRoutes("1", actions, [pr("renovate[bot]")]));
    const noLogin: Reader = { login: async () => assert.fail("login looked up"), owns: async () => true };
    await originOf(release("1"), noLogin, gh.runner);
  });

  test("a release a person published, or one for someone else's merge, stays", async () => {
    const gh = fakeGitHub([], {
      ...releaseRoutes("1", { login: "me", type: "User" }, [pr("renovate[bot]")]),
      ...releaseRoutes("2", actions, [pr("someone")]),
      ...releaseRoutes("3", actions, []),
      ...releaseRoutes("4", null, [pr("renovate[bot]")]),
    });
    for (const id of ["1", "2", "3", "4"]) assert.equal(await originOf(release(id), me(), gh.runner), null, id);
  });

  test("outside the reader's repositories nothing counts, and nothing is looked up", async () => {
    const gh = fakeGitHub([], {
      "repos/o/r/pulls/5": ownClosed, "repos/o/r/pulls/6": pr("renovate[bot]"), "repos/o/r/pulls/7": releasePleasePr,
      ...releaseRoutes("1", actions, [pr("renovate[bot]")]),
      ...commentRoutes([]),
    });
    for (const t of [thread("5"), thread("6"), thread("7"), release("1")]) assert.equal(await originOf(t, me(false), gh.runner), null);
    assert.deepEqual(gh.calls, []);
  });

  test("a closed pull request the reader opened, that nobody answered since, is the reader's own", async () => {
    const gh = fakeGitHub([], { "repos/o/r/pulls/5": ownClosed, ...commentRoutes([]) });
    assert.equal(await originOf(thread("5"), me(), gh.runner), "own-closed");
  });

  test("bots, the reader and people before the close do not keep the reader's closed pull request", async () => {
    const gh = fakeGitHub([], {
      "repos/o/r/pulls/5": ownClosed,
      ...commentRoutes(
        [comment("someone", "2026-10-19T11:00:00Z"), comment("chatgpt-codex-connector[bot]", "2026-10-19T12:05:00Z")],
        [{ ...comment("me", ""), submitted_at: "2026-10-19T12:10:00Z" }],
      ),
    });
    assert.equal(await originOf(thread("5"), me(), gh.runner), "own-closed");
  });

  test("a person who comments or reviews after the close keeps it", async () => {
    for (const routes of [
      commentRoutes([comment("someone", "2026-10-19T12:01:00Z")]),
      commentRoutes([], [{ ...comment("someone", ""), submitted_at: "2026-10-19T12:01:00Z" }]),
      commentRoutes([], [], [comment("someone", CLOSED)]),
    ]) {
      const gh = fakeGitHub([], { "repos/o/r/pulls/5": ownClosed, ...routes });
      assert.equal(await originOf(thread("5"), me(), gh.runner), null);
    }
  });

  test("an open pull request, someone else's, or one outside the reader's repositories stays", async () => {
    const open = fakeGitHub([], { "repos/o/r/pulls/5": { ...pr("me"), state: "open", closed_at: null } });
    assert.equal(await originOf(thread("5"), me(), open.runner), null);
    assert.deepEqual(open.lookups(), [`${API}repos/o/r/pulls/5`], "an open pull request costs one lookup");
    const reopened = fakeGitHub([], { "repos/o/r/pulls/5": { ...ownClosed, state: "open" }, ...commentRoutes([]) });
    assert.equal(await originOf(thread("5"), me(), reopened.runner), null, "only the state says a pull request is closed");
    const theirs = fakeGitHub([], { "repos/o/r/pulls/5": { ...ownClosed, user: { login: "someone", type: "User" } }, ...commentRoutes([]) });
    assert.equal(await originOf(thread("5"), me(), theirs.runner), null);
    const upstream = fakeGitHub([], { "repos/o/r/pulls/5": ownClosed, ...commentRoutes([]) });
    assert.equal(await originOf(thread("5"), me(false), upstream.runner), null);
  });

  test("issues and threads without a subject are never looked up", async () => {
    const gh = fakeGitHub([]);
    assert.equal(await originOf(thread("1", { subject: { type: "Issue", title: "t", url: "u" } }), me(), gh.runner), null);
    assert.equal(await originOf(thread("1", { subject: { type: "PullRequest", title: "t", url: null } }), me(), gh.runner), null);
    assert.deepEqual(gh.calls, []);
  });

  test("a pull request that no longer exists comes from nobody", async () => {
    const gh = fakeGitHub([], { "repos/o/r/pulls/9": new Error("gh: Not Found (HTTP 404)") });
    assert.equal(await originOf(thread("9"), me(), gh.runner), null);
  });

  test("pull request 404 failing for another reason is still an error", async () => {
    // execFile puts the command line, and so the URL ending in /pulls/404, into the message.
    const gh = fakeGitHub([], { "repos/o/r/pulls/404": new Error(`Command failed: gh api ${API}repos/o/r/pulls/404\ngh: Bad credentials (HTTP 401)`) });
    await assert.rejects(originOf(thread("404"), me(), gh.runner), /HTTP 401/);
  });
});

describe("reader", () => {
  test("without listed owners, the reader's repositories are those of the reader's account", async () => {
    const gh = fakeGitHub([]);
    const r = reader([], gh.runner);
    assert.equal(await r.owns("me/x"), true);
    assert.equal(await r.owns("ME/y"), true);
    assert.equal(await r.owns("someone/x"), false);
    assert.deepEqual(gh.lookups(), ["user"], "the login is looked up once");
  });

  test("listed owners replace the reader's account and need no lookup", async () => {
    const gh = fakeGitHub([]);
    const r = reader(["Me", "my-org"], gh.runner);
    assert.equal(await r.owns("me/x"), true);
    assert.equal(await r.owns("my-org/x"), true);
    assert.equal(await r.owns("someone-else/x"), false);
    assert.deepEqual(gh.calls, []);
  });

  test("a failed login lookup is retried rather than remembered", async () => {
    let fail = true;
    const runner: Runner = async () => {
      if (fail) { fail = false; throw new Error("gh: timeout"); }
      return { stdout: JSON.stringify({ login: "me" }) };
    };
    const r = reader([], runner);
    await assert.rejects(r.login(), /timeout/);
    assert.equal(await r.login(), "me");
  });
});

describe("personMentions", () => {
  const by = (type: string, body: string) => ({ user: { login: "someone", type }, body });

  test("another person's comment or review that mentions the reader", () => {
    assert.equal(personMentions([by("User", "@me look")], "me"), true);
    assert.equal(personMentions([by("User", "cc @ME")], "me"), true);
  });

  test("a team mention counts", () => {
    assert.equal(personMentions([by("User", "@org/maintainers")], "me"), true);
  });

  test("a bot's mention, the reader's own, another login that starts like the reader's, or no mention, does not", () => {
    assert.equal(personMentions([
      by("Bot", "thanks @me"), by("User", "ask @me-bot"), by("User", "write to x@me.com"),
      by("User", "see https://x.test/@me"), by("User", "looks fine"), { user: null, body: null },
      { user: { login: "me", type: "User" }, body: "agent note for @me" },
    ], "me"), false);
  });
});

describe("answeredSince", () => {
  test("only another person's comment at or after the close counts", () => {
    assert.equal(answeredSince([comment("someone", CLOSED)], "me", CLOSED), true);
    assert.equal(answeredSince([comment("someone", "2026-10-19T11:59:59Z")], "me", CLOSED), false);
    assert.equal(answeredSince([comment("me", "2026-10-19T13:00:00Z"), comment("vercel[bot]", "2026-10-19T13:00:00Z")], "me", CLOSED), false);
  });

  test("a comment without a readable date counts, so the thread is kept", () => {
    assert.equal(answeredSince([{ user: { login: "someone", type: "User" }, body: "?" }], "me", CLOSED), true);
  });
});

describe("sweep", () => {
  test("clears Renovate threads and keeps a person's pull request", async () => {
    const gh = fakeGitHub([thread("1"), thread("2"), thread("3", { reason: "review_requested" })], {
      "repos/o/r/pulls/1": pr("renovate[bot]"), "repos/o/r/pulls/2": pr("someone"), "repos/o/r/pulls/3": pr("renovate[bot]"),
    });
    const lines: string[] = [];
    const report = await sweep({ owners: ["o"], state: {}, now: 0, fetch: changed, runner: gh.runner, log: (l) => lines.push(l) });
    assert.deepEqual(gh.deleted, ["1", "3"]);
    assert.deepEqual(report.cleared.map((t) => t.id), ["1", "3"]);
    assert.match(lines[0]!, /^cleared o\/r PullRequest 1 \(subscribed\)/);
  });

  test("clears automated releases and keeps the rest", async () => {
    const gh = fakeGitHub([release("10"), release("11"), release("12")], {
      ...releaseRoutes("10", actions, [pr("renovate[bot]")]),
      ...releaseRoutes("11", actions, [pr("someone")]),
      ...releaseRoutes("12", actions, [pr("me")]),
    });
    await sweep({ owners: ["o"], state: {}, now: 0, fetch: changed, runner: gh.runner, log: quiet });
    assert.deepEqual(gh.deleted, ["10", "12"]);
    assert.equal(gh.calls.filter((c) => c === "user").length, 1, "the reader is looked up once per run");
  });

  test("lists read threads too, since opening a pull request does not remove it from the inbox", async () => {
    const gh = fakeGitHub([]);
    const seen: string[] = [];
    await sweep({ owners: ["o"], state: {}, now: 0, fetch: async (e) => { seen.push(e); return changed("", {}); }, runner: gh.runner });
    assert.match(seen[0]!, /all=true/);
    assert.match(gh.calls[0]!, /^notifications\?all=true/);
  });

  test("a mention on a Renovate pull request stays", async () => {
    const gh = fakeGitHub([thread("1", { reason: "mention" })], { "repos/o/r/pulls/1": pr("renovate[bot]") });
    await sweep({ owners: ["o"], state: {}, now: 0, fetch: changed, runner: gh.runner, log: quiet });
    assert.deepEqual(gh.deleted, []);
  });

  test("a release-please pull request is cleared despite the mention in its changelog", async () => {
    const gh = fakeGitHub([thread("5", { reason: "mention" })], {
      "repos/o/r/pulls/5": releasePleasePr,
      "repos/o/r/issues/5/comments": [], "repos/o/r/pulls/5/reviews": [], "repos/o/r/pulls/5/comments": [],
    });
    await sweep({ owners: ["o"], state: {}, now: 0, fetch: changed, runner: gh.runner, log: quiet });
    assert.deepEqual(gh.deleted, ["5"]);
  });

  test("an automated release whose notes credit the reader is still cleared", async () => {
    const gh = fakeGitHub([{ ...release("10"), reason: "mention" }], releaseRoutes("10", actions, [releasePleasePr]));
    await sweep({ owners: ["o"], state: {}, now: 0, fetch: changed, runner: gh.runner, log: quiet });
    assert.deepEqual(gh.deleted, ["10"]);
  });

  test("threads outside the listed owners' repositories stay, Renovate's included", async () => {
    const gh = fakeGitHub([thread("5"), thread("6")], { "repos/o/r/pulls/5": releasePleasePr, "repos/o/r/pulls/6": pr("renovate[bot]") });
    await sweep({ state: {}, now: 0, owners: ["mine"], fetch: changed, runner: gh.runner, log: quiet });
    assert.deepEqual(gh.deleted, []);
    assert.deepEqual(gh.lookups(), []);
  });

  test("a mentioned release-please pull request deleted meanwhile is cleared", async () => {
    const gh = fakeGitHub([thread("5", { reason: "mention" })], { "repos/o/r/pulls/5": releasePleasePr });
    await sweep({ state: {}, now: 0, owners: ["o"], fetch: changed, runner: gh.runner, log: quiet });
    assert.deepEqual(gh.deleted, ["5"]);
  });

  test("a mentioned closed pull request of the reader's reads its comments once", async () => {
    const gh = fakeGitHub([thread("5", { reason: "mention" })], { "repos/o/r/pulls/5": ownClosed, ...commentRoutes([]) });
    await sweep({ state: {}, now: 0, owners: ["o"], fetch: changed, runner: gh.runner, log: quiet });
    assert.equal(gh.lookups().filter((c) => c.includes("/comments") || c.includes("/reviews")).length, 3);
  });

  test("the reader's closed pull request is cleared despite a review bot's mention", async () => {
    const gh = fakeGitHub([thread("5", { reason: "mention" })], {
      "repos/o/r/pulls/5": ownClosed,
      ...commentRoutes([comment("chatgpt-codex-connector[bot]", "2026-10-19T11:00:00Z", "@me review done")]),
    });
    await sweep({ owners: ["o"], state: {}, now: 0, fetch: changed, runner: gh.runner, log: quiet });
    assert.deepEqual(gh.deleted, ["5"]);
  });

  test("the reader's closed pull request where a person mentioned the reader stays", async () => {
    const gh = fakeGitHub([thread("5", { reason: "mention" })], {
      "repos/o/r/pulls/5": ownClosed,
      ...commentRoutes([comment("someone", "2026-10-19T11:00:00Z", "@me why this way?")]),
    });
    await sweep({ owners: ["o"], state: {}, now: 0, fetch: changed, runner: gh.runner, log: quiet });
    assert.deepEqual(gh.deleted, []);
  });

  test("a release-please pull request where a person mentions the reader stays", async () => {
    const gh = fakeGitHub([thread("5", { reason: "mention" })], {
      "repos/o/r/pulls/5": releasePleasePr,
      "repos/o/r/issues/5/comments": [{ user: { type: "User" }, body: "@me can this ship?" }],
      "repos/o/r/pulls/5/reviews": [], "repos/o/r/pulls/5/comments": [],
    });
    await sweep({ owners: ["o"], state: {}, now: 0, fetch: changed, runner: gh.runner, log: quiet });
    assert.deepEqual(gh.deleted, []);
  });

  test("a release-please pull request without a mention is cleared without reading its comments", async () => {
    const gh = fakeGitHub([thread("5")], { "repos/o/r/pulls/5": releasePleasePr });
    await sweep({ owners: ["o"], state: {}, now: 0, fetch: changed, runner: gh.runner, log: quiet });
    assert.deepEqual(gh.deleted, ["5"]);
    assert.deepEqual(gh.lookups(), [`${API}repos/o/r/pulls/5`]);
  });

  test("a thread stays protected after a mention even when a later event changes its reason", async () => {
    const routes = { "repos/o/r/pulls/1": pr("renovate[bot]") };
    const mentioned = fakeGitHub([thread("1", { reason: "mention" })], routes);
    const first = await sweep({ owners: ["o"], state: {}, now: 0, fetch: changed, runner: mentioned.runner, log: quiet });
    const rebased = fakeGitHub([thread("1", { reason: "subscribed", updated_at: "2026-10-19T13:05:00Z" })], routes);
    await sweep({ owners: ["o"], state: first.state, now: 60_000, fetch: changed, runner: rebased.runner, log: quiet });
    assert.deepEqual(rebased.deleted, []);
  });

  test("a mention stops protecting a thread after 90 days", async () => {
    const gh = fakeGitHub([thread("1")], { "repos/o/r/pulls/1": pr("renovate[bot]") });
    await sweep({ owners: ["o"], state: { mentioned: { "1": 0 } }, now: 91 * 86_400_000, fetch: changed, runner: gh.runner, log: quiet });
    assert.deepEqual(gh.deleted, ["1"]);
  });

  test("a thread already cleared is not looked up again until it changes", async () => {
    const routes = { "repos/o/r/pulls/1": pr("renovate[bot]") };
    const gh = fakeGitHub([thread("1")], routes);
    const first = await sweep({ owners: ["o"], state: {}, now: Date.parse(UPDATED), fetch: changed, runner: gh.runner, log: quiet });
    const before = gh.lookups().length;
    await sweep({ owners: ["o"], state: first.state, now: Date.parse(UPDATED) + 60_000, fetch: changed, runner: gh.runner, log: quiet });
    assert.equal(gh.lookups().length, before);
    const updated = fakeGitHub([thread("1", { updated_at: "2026-10-19T13:02:00Z" })], routes);
    await sweep({ owners: ["o"], state: first.state, now: Date.parse(UPDATED) + 120_000, fetch: changed, runner: updated.runner, log: quiet });
    assert.deepEqual(updated.deleted, ["1"]);
  });

  test("a thread that was kept is not looked up again until it changes", async () => {
    const gh = fakeGitHub([thread("2")], { "repos/o/r/pulls/2": pr("someone") });
    const first = await sweep({ owners: ["o"], state: {}, now: Date.parse(UPDATED), fetch: changed, runner: gh.runner, log: quiet });
    const before = gh.lookups().length;
    await sweep({ owners: ["o"], state: first.state, now: Date.parse(UPDATED) + 60_000, fetch: changed, runner: gh.runner, log: quiet });
    assert.equal(gh.lookups().length, before);
    assert.deepEqual(gh.deleted, []);
  });

  test("later listings start ten minutes before the previous one and forget older decisions", async () => {
    const gh = fakeGitHub([]);
    const listedAt = Date.parse("2026-10-19T13:20:00Z");
    const report = await sweep({
      state: { listedAt, decided: { old: "2026-10-19T13:00:00Z", recent: "2026-10-19T13:15:00Z" } },
      now: listedAt + 60_000, fetch: changed, runner: gh.runner,
    });
    assert.equal(gh.calls[0], "notifications?all=true&per_page=50&since=2026-10-19T13:10:00.000Z");
    assert.deepEqual(report.state.decided, { recent: "2026-10-19T13:15:00Z" });
    assert.equal(report.state.listedAt, listedAt + 60_000);
  });

  test("a 304 lists nothing and keeps what was decided before", async () => {
    const gh = fakeGitHub([thread("1")]);
    const seen: Record<string, string>[] = [];
    const notModified: Fetch = async (_e, headers) => { seen.push(headers); return response(304, { "X-Poll-Interval": "60" }); };
    const state = { lastModified, listedAt: 5, decided: { "1": UPDATED } };
    const report = await sweep({ state, now: 1_000, fetch: notModified, runner: gh.runner });
    assert.deepEqual(seen, [{ "If-Modified-Since": lastModified }]);
    assert.equal(gh.calls.length, 0);
    assert.deepEqual(report.state, { ...state, nextPollAt: 61_000 });
  });

  test("the first poll is unconditional", async () => {
    const seen: Record<string, string>[] = [];
    const gh = fakeGitHub([]);
    await sweep({ owners: ["o"], state: {}, now: 0, fetch: async (_e, h) => { seen.push(h); return changed("", {}); }, runner: gh.runner });
    assert.deepEqual(seen, [{}]);
  });

  test("waits out a poll interval GitHub raised", async () => {
    const gh = fakeGitHub([]);
    const slow: Fetch = async () => response(200, { "Last-Modified": lastModified, "X-Poll-Interval": "300" });
    const first = await sweep({ owners: ["o"], state: {}, now: 0, fetch: slow, runner: gh.runner });
    assert.equal(first.state.nextPollAt, 300_000);
    let fetched = false;
    const second = await sweep({ owners: ["o"], state: first.state, now: 120_000, fetch: async () => { fetched = true; return slow("", {}); }, runner: gh.runner });
    assert.equal(fetched, false);
    assert.equal(second.polled, false);
    assert.deepEqual(second.state, first.state);
  });

  test("a dry run lists what it would clear and marks nothing", async () => {
    const gh = fakeGitHub([thread("1")], { "repos/o/r/pulls/1": pr("renovate[bot]") });
    const lines: string[] = [];
    const report = await sweep({ owners: ["o"], state: {}, now: 0, dryRun: true, fetch: changed, runner: gh.runner, log: (l) => lines.push(l) });
    assert.deepEqual(gh.deleted, []);
    assert.equal(report.cleared.length, 1);
    assert.match(lines[0]!, /^would clear/);
  });

  test("a failed lookup is reported and the other threads are still cleared", async () => {
    const gh = fakeGitHub([thread("1"), thread("2")], {
      "repos/o/r/pulls/1": new Error("gh: Bad credentials (HTTP 401)"), "repos/o/r/pulls/2": pr("renovate[bot]"),
    });
    const report = await sweep({ owners: ["o"], state: {}, now: 0, fetch: changed, runner: gh.runner, log: quiet });
    assert.deepEqual(gh.deleted, ["2"]);
    assert.equal(report.errors.length, 1);
    assert.match(report.errors[0]!, /^o\/r PR 1: .*401/);
    assert.equal(report.state.decided?.["1"], undefined, "retried on the next listing");
  });

  test("an unexpected status fails the run", async () => {
    const gh = fakeGitHub([]);
    await assert.rejects(sweep({ owners: ["o"], state: {}, now: 0, fetch: async () => response(500), runner: gh.runner }), /500/);
  });
});

describe("markDone", () => {
  test("refuses an id that is not a number, so nothing else can reach the DELETE", async () => {
    const gh = fakeGitHub([]);
    await assert.rejects(markDone("1/../../user", gh.runner), /Unexpected notification thread id/);
    assert.equal(gh.calls.length, 0);
  });
});

describe("sweep state", () => {
  test("round-trips through the state file", () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), "sweep-")), "nested", "notifications.json");
    saveSweepState({ lastModified, nextPollAt: 5, decided: { "1": UPDATED } }, file);
    assert.deepEqual(loadSweepState(file), { lastModified, nextPollAt: 5, decided: { "1": UPDATED } });
  });

  test("a missing or corrupt file starts fresh", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "sweep-"));
    assert.deepEqual(loadSweepState(path.join(dir, "missing.json")), {});
    writeFileSync(path.join(dir, "bad.json"), "{not json");
    assert.deepEqual(loadSweepState(path.join(dir, "bad.json")), {});
    writeFileSync(path.join(dir, "array.json"), "[]");
    assert.deepEqual(loadSweepState(path.join(dir, "array.json")), {});
  });
});
