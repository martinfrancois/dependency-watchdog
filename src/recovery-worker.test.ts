import test from "node:test";
import assert from "node:assert/strict";
import { processIncident, type WorkerIO } from "./recovery-worker.ts";
import { makeIncident, type Incident } from "./recovery.ts";
import { DEFAULTS } from "./config.ts";
const fresh = () => makeIncident({ id: "x", repo: "o/r", kind: "failing", url: "https://github.com/o/r" });
const result = { category: "repository", outcome: "review", summary: "fixed", prUrls: ["https://github.com/o/r/pull/2"], tests: ["npm test"], deployedRevision: null, verification: [] };
const io = (over: Partial<WorkerIO> = {}): WorkerIO => ({ save: () => {}, notify: async () => {}, execute: async () => result, verify: async () => {}, ...over });
test("notifies investigating then review only after independent verification", async () => {
  const incident = fresh(); const events: string[] = [];
  await processIncident(incident, DEFAULTS.recovery, io({ notify: async (i) => { events.push(i.status); }, verify: async () => { events.push("verified"); } }));
  assert.deepEqual(events, ["investigating", "verified", "review"]);
  assert.equal(incident.attempts, 1);
});
test("failed verification retries and eventually reports red blocked", async () => {
  const incident = fresh();
  await processIncident(incident, DEFAULTS.recovery, io({ verify: async () => { throw new Error("still fails"); } }));
  assert.equal(incident.status, "blocked"); assert.equal(incident.attempts, 2); assert.equal(incident.error, "still fails");
});
test("Codex declared blockers stop without retrying rejected actions", async () => {
  const incident = fresh();
  await processIncident(incident, DEFAULTS.recovery, io({ execute: async () => ({ ...result, outcome: "blocked", summary: "cannot run tests" }) }));
  assert.equal(incident.status, "blocked"); assert.match(incident.error!, /cannot run/); assert.equal(incident.attempts, 1);
});
test("a notification failure does not repeat a completed repair", async () => {
  const incident = fresh(); let executions = 0;
  const deps = io({ execute: async () => { executions++; return result; }, notify: async (i) => { if (i.status === "review") throw new Error("telegram unavailable"); } });
  await assert.rejects(processIncident(incident, DEFAULTS.recovery, deps), /telegram/);
  assert.equal(incident.status, "review");
  await processIncident(incident, DEFAULTS.recovery, deps);
  assert.equal(executions, 1);
});
test("a verified watchdog repair completes as resolved", async () => {
  const incident = fresh();
  await processIncident(incident, DEFAULTS.recovery, io({ execute: async () => ({ ...result, category: "watchdog", outcome: "fixed", deployedRevision: "abc", verification: ["fresh scan"] }) }));
  assert.equal(incident.status, "resolved");
});

test("a broken notifier does not prevent investigation or lose the completed repair", async () => {
  const incident = fresh(); let executed = 0;
  await assert.rejects(processIncident(incident, DEFAULTS.recovery, io({
    notify: async () => { throw new Error("notifier broken"); },
    execute: async () => { executed++; return result; },
  })), /notifier broken/);
  assert.equal(executed, 1);
  assert.equal(incident.status, "review");
  assert.equal(incident.notificationError, "notifier broken");
});
