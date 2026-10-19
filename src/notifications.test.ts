import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { Runner } from "./github.ts";
import {
  interpret,
  loadSweepState,
  markDone,
  openedBy,
  parseResponse,
  saveSweepState,
  sweep,
  type Fetch,
  type Response,
  type Thread,
} from "./notifications.ts";

const UPDATED = "2026-10-19T13:00:00Z";

const thread = (id: string, over: Partial<Thread> = {}): Thread => ({
  id,
  reason: "subscribed",
  updated_at: UPDATED,
  subject: { type: "PullRequest", title: `PR ${id}`, url: `https://api.github.com/repos/o/r/pulls/${id}` },
  repository: { full_name: "o/r" },
  ...over,
});

const release = (id: string, tag: string): Thread => thread(id, {
  subject: { type: "Release", title: `Release ${tag}`, url: `https://api.github.com/repos/o/r/releases/${id}` },
});

const response = (status: number, headers: Record<string, string> = {}): Response => ({
  status,
  headers: new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])),
  body: "",
});

/**
 * A fake gh: the inbox, who opened each pull request, which pull request merged each release tag,
 * and a record of every call made. A pull request number maps to an author or to the error its
 * lookup throws.
 */
function fakeGitHub(threads: Thread[], authors: Record<string, string | Error>, tags: Record<string, string> = {}) {
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
    const release = /\/releases\/(\d+)$/.exec(endpoint);
    if (release) return { stdout: JSON.stringify({ tag_name: `tag-${release[1]}` }) };
    const tag = /\/commits\/(tag-\d+)$/.exec(endpoint);
    if (tag) return { stdout: JSON.stringify({ sha: `sha-${tag[1]}` }) };
    const pulls = /\/commits\/sha-(tag-\d+)\/pulls$/.exec(endpoint);
    if (pulls) {
      const number = tags[pulls[1]!];
      return { stdout: JSON.stringify(number === undefined ? [] : [{ user: { login: authors[number] } }]) };
    }
    const author = authors[endpoint.split("/").pop()!];
    if (author instanceof Error) throw author;
    return { stdout: JSON.stringify({ user: { login: author } }) };
  };
  return { runner, deleted, calls };
}

const lastModified = "Mon, 19 Oct 2026 13:28:39 GMT";
const changed: Fetch = async () => response(200, { "Last-Modified": lastModified, "X-Poll-Interval": "60" });
const quiet = () => {};

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

describe("openedBy", () => {
  test("a pull request's author", async () => {
    const gh = fakeGitHub([], { "7": "renovate[bot]" });
    assert.equal(await openedBy(thread("7"), gh.runner), "renovate[bot]");
  });

  test("a release is attributed to the pull request that merged its tagged commit", async () => {
    const gh = fakeGitHub([], { "7": "renovate[bot]", "8": "someone" }, { "tag-1": "7", "tag-2": "8" });
    assert.equal(await openedBy(release("1", "tag-1"), gh.runner), "renovate[bot]");
    assert.equal(await openedBy(release("2", "tag-2"), gh.runner), "someone");
  });

  test("a release whose commit was pushed without a pull request has no author", async () => {
    const gh = fakeGitHub([], {});
    assert.equal(await openedBy(release("3", "tag-3"), gh.runner), null);
  });

  test("issues and threads without a subject are never looked up", async () => {
    const gh = fakeGitHub([], {});
    assert.equal(await openedBy(thread("1", { subject: { type: "Issue", title: "t", url: "u" } }), gh.runner), null);
    assert.equal(await openedBy(thread("1", { subject: { type: "PullRequest", title: "t", url: null } }), gh.runner), null);
    assert.deepEqual(gh.calls, []);
  });

  test("a pull request that no longer exists has no author", async () => {
    const gh = fakeGitHub([], { "9": new Error("gh: Not Found (HTTP 404)") });
    assert.equal(await openedBy(thread("9"), gh.runner), null);
  });

  test("pull request 404 failing for another reason is still an error", async () => {
    // execFile puts the command line, and so the URL ending in /pulls/404, into the message.
    const gh = fakeGitHub([], { "404": new Error("Command failed: gh api https://api.github.com/repos/o/r/pulls/404\ngh: Bad credentials (HTTP 401)") });
    await assert.rejects(openedBy(thread("404"), gh.runner), /HTTP 401/);
  });
});

describe("sweep", () => {
  test("clears Renovate threads and keeps a person's pull request", async () => {
    const gh = fakeGitHub([thread("1"), thread("2"), thread("3", { reason: "review_requested" })], {
      "1": "renovate[bot]", "2": "someone", "3": "renovate[bot]",
    });
    const lines: string[] = [];
    const report = await sweep({ state: {}, now: 0, fetch: changed, runner: gh.runner, log: (l) => lines.push(l) });
    assert.deepEqual(gh.deleted, ["1", "3"]);
    assert.deepEqual(report.cleared.map((t) => t.id), ["1", "3"]);
    assert.match(lines[0]!, /^cleared o\/r PullRequest 1 \(subscribed\)/);
  });

  test("clears a release published by merging a Renovate pull request, not one from a person", async () => {
    const gh = fakeGitHub([release("10", "tag-10"), release("11", "tag-11")], { "7": "renovate[bot]", "8": "someone" }, { "tag-10": "7", "tag-11": "8" });
    await sweep({ state: {}, now: 0, fetch: changed, runner: gh.runner, log: quiet });
    assert.deepEqual(gh.deleted, ["10"]);
  });

  test("lists read threads too, since opening a pull request does not remove it from the inbox", async () => {
    const gh = fakeGitHub([], {});
    const seen: string[] = [];
    await sweep({ state: {}, now: 0, fetch: async (e) => { seen.push(e); return changed("", {}); }, runner: gh.runner });
    assert.match(seen[0]!, /all=true/);
    assert.match(gh.calls[0]!, /^notifications\?all=true/);
  });

  test("a mention on a Renovate pull request is never looked up or cleared", async () => {
    const gh = fakeGitHub([thread("1", { reason: "mention" })], { "1": "renovate[bot]" });
    await sweep({ state: {}, now: 0, fetch: changed, runner: gh.runner, log: quiet });
    assert.deepEqual(gh.deleted, []);
    assert.equal(gh.calls.length, 1, "only the listing");
  });

  test("a thread stays protected after a mention even when a later event changes its reason", async () => {
    const mentioned = fakeGitHub([thread("1", { reason: "mention" })], { "1": "renovate[bot]" });
    const first = await sweep({ state: {}, now: 0, fetch: changed, runner: mentioned.runner, log: quiet });
    const rebased = fakeGitHub([thread("1", { reason: "subscribed", updated_at: "2026-10-19T13:05:00Z" })], { "1": "renovate[bot]" });
    await sweep({ state: first.state, now: 60_000, fetch: changed, runner: rebased.runner, log: quiet });
    assert.deepEqual(rebased.deleted, []);
  });

  test("a mention stops protecting a thread after 90 days", async () => {
    const gh = fakeGitHub([thread("1")], { "1": "renovate[bot]" });
    await sweep({ state: { mentioned: { "1": 0 } }, now: 91 * 86_400_000, fetch: changed, runner: gh.runner, log: quiet });
    assert.deepEqual(gh.deleted, ["1"]);
  });

  test("a thread already cleared is not looked up again until it changes", async () => {
    const gh = fakeGitHub([thread("1")], { "1": "renovate[bot]" });
    const first = await sweep({ state: {}, now: Date.parse(UPDATED), fetch: changed, runner: gh.runner, log: quiet });
    const before = gh.calls.length;
    await sweep({ state: first.state, now: Date.parse(UPDATED) + 60_000, fetch: changed, runner: gh.runner, log: quiet });
    assert.deepEqual(gh.calls.slice(before).filter((c) => !c.startsWith("notifications")), []);
    const updated = fakeGitHub([thread("1", { updated_at: "2026-10-19T13:02:00Z" })], { "1": "renovate[bot]" });
    await sweep({ state: first.state, now: Date.parse(UPDATED) + 120_000, fetch: changed, runner: updated.runner, log: quiet });
    assert.deepEqual(updated.deleted, ["1"]);
  });

  test("a thread that was kept is not looked up again until it changes", async () => {
    const gh = fakeGitHub([thread("2")], { "2": "someone" });
    const first = await sweep({ state: {}, now: Date.parse(UPDATED), fetch: changed, runner: gh.runner, log: quiet });
    const before = gh.calls.length;
    await sweep({ state: first.state, now: Date.parse(UPDATED) + 60_000, fetch: changed, runner: gh.runner, log: quiet });
    assert.deepEqual(gh.calls.slice(before).filter((c) => !c.startsWith("notifications")), []);
    assert.deepEqual(gh.deleted, []);
  });

  test("later listings start ten minutes before the previous one and forget older decisions", async () => {
    const gh = fakeGitHub([], {});
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
    const gh = fakeGitHub([thread("1")], { "1": "renovate[bot]" });
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
    const gh = fakeGitHub([], {});
    await sweep({ state: {}, now: 0, fetch: async (_e, h) => { seen.push(h); return changed("", {}); }, runner: gh.runner });
    assert.deepEqual(seen, [{}]);
  });

  test("waits out a poll interval GitHub raised", async () => {
    const gh = fakeGitHub([], {});
    const slow: Fetch = async () => response(200, { "Last-Modified": lastModified, "X-Poll-Interval": "300" });
    const first = await sweep({ state: {}, now: 0, fetch: slow, runner: gh.runner });
    assert.equal(first.state.nextPollAt, 300_000);
    let fetched = false;
    const second = await sweep({ state: first.state, now: 120_000, fetch: async () => { fetched = true; return slow("", {}); }, runner: gh.runner });
    assert.equal(fetched, false);
    assert.equal(second.polled, false);
    assert.deepEqual(second.state, first.state);
  });

  test("a dry run lists what it would clear and marks nothing", async () => {
    const gh = fakeGitHub([thread("1")], { "1": "renovate[bot]" });
    const lines: string[] = [];
    const report = await sweep({ state: {}, now: 0, dryRun: true, fetch: changed, runner: gh.runner, log: (l) => lines.push(l) });
    assert.deepEqual(gh.deleted, []);
    assert.equal(report.cleared.length, 1);
    assert.match(lines[0]!, /^would clear/);
  });

  test("a failed lookup is reported and the other threads are still cleared", async () => {
    const gh = fakeGitHub([thread("1"), thread("2")], { "1": new Error("gh: Bad credentials (HTTP 401)"), "2": "renovate[bot]" });
    const report = await sweep({ state: {}, now: 0, fetch: changed, runner: gh.runner, log: quiet });
    assert.deepEqual(gh.deleted, ["2"]);
    assert.equal(report.errors.length, 1);
    assert.match(report.errors[0]!, /^o\/r PR 1: .*401/);
    assert.equal(report.state.decided?.["1"], undefined, "retried on the next listing");
  });

  test("an unexpected status fails the run", async () => {
    const gh = fakeGitHub([], {});
    await assert.rejects(sweep({ state: {}, now: 0, fetch: async () => response(500), runner: gh.runner }), /500/);
  });
});

describe("markDone", () => {
  test("refuses an id that is not a number, so nothing else can reach the DELETE", async () => {
    const gh = fakeGitHub([], {});
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
