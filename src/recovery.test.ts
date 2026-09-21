import test from "node:test";
import assert from "node:assert/strict";
import { makeIncident, recoveryPrompt, statusMessage, validateResult, shouldQueue } from "./recovery.ts";
import type { Finding } from "./types.ts";

const finding: Finding = { id: "automerge-stuck:o/r#2", repo: "o/r", number: 2, sha: "abc", kind: "dependency PR failing", url: "https://github.com/o/r/pull/2" };
const options = { enabled: true, codexCommand: "codex", watchdogRepo: "o/watchdog", watchdogCheckout: "/opt/watchdog", workspaceRoot: "/var/tmp/recovery-work", timeoutMinutes: 90, maxAttempts: 2, allowWatchdogMerge: true };

test("incident keys are stable and cannot escape the private directory", () => {
  assert.equal(makeIncident(finding).key, makeIncident({ ...finding, title: "other" }).key);
  assert.match(makeIncident({ ...finding, id: "../../escape" }).key, /^[a-f0-9]{32}$/);
});
test("active and review incidents do not launch duplicate agents", () => {
  const incident = makeIncident(finding);
  for (const status of ["queued", "investigating", "review", "blocked"] as const) {
    assert.equal(shouldQueue({ ...incident, status }, finding), false);
  }
  assert.equal(shouldQueue({ ...incident, status: "resolved" }, finding), true);
});
test("the prompt requires watchdog repair, redeployment, and verification", () => {
  const prompt = recoveryPrompt(makeIncident(finding), options);
  for (const part of ["redeploy", "independent", "MUST NOT merge", "untrusted", "MUST NOT disable", "allowWatchdogMerge=true"]) assert.ok(prompt.includes(part), part);
});
test("yellow means investigating or review; blocked work is red", () => {
  const incident = makeIncident(finding);
  assert.match(statusMessage({ ...incident, status: "investigating" }), /^🟡.*Codex is investigating/);
  assert.match(statusMessage({ ...incident, status: "review", result: { category: "repository", outcome: "review", summary: "fixed", prUrls: ["https://github.com/o/r/pull/3"], tests: ["npm test"], deployedRevision: null, verification: [] } }), /^🟡.*review/);
  assert.match(statusMessage({ ...incident, status: "blocked", error: "no codex" }), /^🔴/);
});
test("a claimed fix without validation or deployment is rejected", () => {
  assert.throws(() => validateResult({ category: "watchdog", outcome: "fixed", summary: "done", tests: [], prUrls: [], deployedRevision: null, verification: [] }), /validation|deployment/);
  assert.throws(() => validateResult({ category: "repository", outcome: "review", summary: "done", tests: ["test"], prUrls: ["https://evil.example/pr/1"], deployedRevision: null, verification: [] }), /PR/);
});
