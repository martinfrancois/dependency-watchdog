import test from "node:test";
import assert from "node:assert/strict";
import { inspect, deliver, safeError } from "./diagnostics.ts";
import { DEFAULTS } from "./config.ts";
import { defaultDeps } from "./checks.ts";
import type { State, Finding } from "./types.ts";

const onlyPrs = { ...DEFAULTS, repos: ["o/r"], checks: { securityPrs: true, failingPrs: true, lockfileRefresh: false, staleExclusions: false, defaultBranchBroken: false } };
const oldPr = { number: 1, title: "update", html_url: "https://github.com/o/r/pull/1", created_at: "2020-01-01T00:00:00Z", labels: [{ name: "security" }], head: { ref: "renovate/x", sha: "abc" } };
const finding: Finding = { id: "security-pr:o/r#1", kind: "security PR unmerged", repo: "o/r", url: "u" };

test("records disabled checks, cached API evidence, and suppresses duplicate security alerts", async () => {
  let calls = 0;
  const report = await inspect(onlyPrs, { seen: {} }, {
    ...defaultDeps,
    openPullRequests: async () => { calls++; return [oldPr]; },
    checkStatus: async () => [{ name: "test", conclusion: "failure" }],
  });
  assert.equal(calls, 1);
  assert.equal(report.findings.length, 1);
  assert.equal(report.checks.filter((c) => c.status === "disabled").length, 3);
  assert.equal(report.decisions[0]!.reason, "confirming");
  assert.ok(report.checks[0]!.evidence.length);
});

test("a failed lookup preserves notified incidents and invalidates unconfirmed sightings", async () => {
  const state: State = { seen: {
    [finding.id]: { first: 1, notified: 2 },
    "security-pr:o/r#2": { first: 1, notified: null },
  } };
  const report = await inspect(onlyPrs, state, {
    ...defaultDeps, openPullRequests: async () => { throw new Error("HTTP 503"); },
  });
  assert.equal(report.complete, false);
  assert.equal(report.nextState.seen[finding.id]!.notified, 2);
  assert.equal(report.nextState.seen["security-pr:o/r#2"], undefined);
  assert.equal(report.resolved.length, 0);
  assert.equal(report.checks.filter((c) => c.status === "error").length, 2);
});

test("reports all suppressed findings and the next reminder date", async () => {
  const report = await inspect(onlyPrs, { seen: { [finding.id]: { first: 1, notified: Date.now() } } }, {
    ...defaultDeps, openPullRequests: async () => [oldPr], checkStatus: async () => [],
  });
  assert.equal(report.findings.length, 1);
  assert.equal(report.notifications.length, 0);
  assert.equal(report.decisions[0]!.reason, "cooldown");
  assert.ok(report.decisions[0]!.nextEligibleAt);
});

test("delivery checkpoints each success and leaves unsent messages retryable", async () => {
  const report = await inspect(onlyPrs, { seen: { [finding.id]: { first: 1, notified: null } } }, {
    ...defaultDeps, openPullRequests: async () => [oldPr], checkStatus: async () => [],
  });
  report.notifications.push({ ...finding, id: "second" });
  report.nextState.seen.second = { first: 1, notified: null };
  const checkpoints: State[] = [];
  await assert.rejects(deliver(report, async (f) => {
    if (f.id === "second") throw new Error("delivery failed");
  }, (state) => { checkpoints.push(structuredClone(state)); }), /delivery failed/);
  assert.equal(report.delivery[finding.id], "sent");
  assert.equal(report.delivery.second, "failed");
  assert.ok(checkpoints.at(-1)!.seen[finding.id]!.notified);
  assert.equal(checkpoints.at(-1)!.seen.second!.notified, null);
});

test("redacts credential URLs and control characters from diagnostics", () => {
  assert.equal(safeError(new Error("failed https://api.telegram.org/botsecret/sendMessage\u001b[31m")), "failed <redacted-url>");
});

test("allows the weekly prune to run before reporting matured exclusions", async () => {
  const settings = { ...onlyPrs, checks: { ...onlyPrs.checks, securityPrs: false, failingPrs: false, staleExclusions: true } };
  const deps = { ...defaultDeps, fileContents: async () => "minimumReleaseAgeExclude:\n  - x@1.0.0\n", publishedAt: async () => 1 };
  const id = "stale-exclusions:o/r";
  const recent = await inspect(settings, { seen: { [id]: { first: Date.now() - 2 * 86400_000, notified: null } } }, deps);
  assert.equal(recent.notifications.length, 0);
  assert.equal(recent.decisions[0]!.reason, "awaiting-prune");
  const overdue = await inspect(settings, { seen: { [id]: { first: Date.now() - 8 * 86400_000, notified: null } } }, deps);
  assert.equal(overdue.notifications.length, 1);
});
