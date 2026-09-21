import test from "node:test";
import assert from "node:assert/strict";
import { evaluateGate, inspectMergeGate, type GateEvidence } from "./merge-gate.ts";
const evidence: GateEvidence = { authenticatedLogin: "owner", owner: "owner", head: "abc", state: "OPEN", checks: [{ name: "test", state: "SUCCESS" }], unresolvedBotThreads: 0, botChangesRequested: 0, botComments: [], truncated: false };
test("owner merge requires green CI and clear bot reviews", () => {
  assert.equal(evaluateGate(evidence).allowed, true);
  for (const change of [{ authenticatedLogin: "contributor" }, { state: "CLOSED" }, { truncated: true }, { unresolvedBotThreads: 1 }, { botChangesRequested: 1 }, { botComments: ["2 issues found"] }, { botComments: ["[P3] Fix the edge case"] }, { botComments: ["❌ Review failed"] }, { checks: [{ name: "test", state: "SKIPPED" }] }, { checks: [] }, { checks: [{ name: "bot", state: "PENDING" }] }]) assert.equal(evaluateGate({ ...evidence, ...change }).allowed, false);
});
test("local checks only substitute explicitly confirmed Actions billing failures", () => {
  const failed = { ...evidence, checks: [{ name: "test", state: "FAILURE", billingBlocked: true }] };
  assert.equal(evaluateGate(failed).allowed, false); assert.equal(evaluateGate(failed, true).allowed, true);
  assert.equal(evaluateGate({ ...failed, unresolvedBotThreads: 1 }, true).allowed, false);
  assert.equal(evaluateGate({ ...evidence, checks: [{ name: "test", state: "FAILURE" }] }, true).allowed, false);
});
test("live gate collects checks and bot threads without accepting partial evidence", async () => {
  const page = <T>(nodes: T[]) => ({ nodes, pageInfo: { hasNextPage: false } });
  const run = async (args: string[]) => args.includes("user") ? '{"login":"owner"}' : args[0] === "pr" ? '{"state":"OPEN","headRefOid":"abc","statusCheckRollup":[{"name":"test","conclusion":"SUCCESS"}]}' : JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: page([]), reviews: page([]), comments: page([]) } } } });
  assert.equal((await inspectMergeGate("owner/watchdog", 2, false, run)).allowed, true);
  await assert.rejects(inspectMergeGate("bad", 0, false, run), /Expected/);
});

test("billing fallback reads explicit annotations and still refuses bot findings", async () => {
  const page = <T>(nodes: T[]) => ({ nodes, pageInfo: { hasNextPage: false } });
  const actor = { login: "reviewer[bot]", __typename: "Bot" };
  const review = { reviewThreads: page([{ isResolved: false, comments: page([{ author: actor }]) }]), reviews: page([{ state: "CHANGES_REQUESTED", author: actor }, { state: "COMMENTED", author: actor }]), comments: page([{ author: actor, body: "2 issues found" }]) };
  const run = async (args: string[]) => {
    if (args.includes("user")) return '{"login":"owner"}';
    if (args[0] === "pr") return JSON.stringify({ state: "OPEN", headRefOid: "abc", statusCheckRollup: [{ name: "test", conclusion: "FAILURE", detailsUrl: "https://github.com/owner/watchdog/actions/runs/1/job/2" }] });
    if (args[1]?.includes("actions/jobs")) return '{"steps":[],"check_run_url":"https://api.github.com/repos/owner/watchdog/check-runs/3"}';
    if (args[1]?.endsWith("annotations")) return '[{"message":"The job was not started because your account has exceeded its spending limit"}]';
    return JSON.stringify({ data: { repository: { pullRequest: review } } });
  };
  const blocked = await inspectMergeGate("owner/watchdog", 2, true, run);
  assert.equal(blocked.allowed, false); assert.ok(blocked.reasons.some((r) => r.includes("Bot review")));
  assert.ok(!blocked.reasons.some((r) => r.startsWith("test:")));
  review.reviewThreads.nodes[0]!.isResolved = true;
  review.reviews.nodes.push({ state: "APPROVED", author: actor });
  review.comments.nodes[0]!.body = "No findings remain";
  assert.equal((await inspectMergeGate("owner/watchdog", 2, true, run)).allowed, true);
  review.reviewThreads.nodes[0]!.comments.pageInfo.hasNextPage = true;
  assert.equal((await inspectMergeGate("owner/watchdog", 2, true, run)).allowed, false);
});
