import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, realpathSync } from "node:fs";
import path from "node:path";
import { DEFAULTS } from "./config.ts";
import { enqueue, incidents, readIncident, saveIncident, rememberRecoverySettings, rememberedRecoverySettings, resolveExecutable, recoveryDirectory, retryIncident, writePrivate } from "./recovery-store.ts";
import { executeCodex, verifyResult, runRecovery, queueWatchdogFailure, notifyIncident, refreshReview, reconcileIncidents } from "./recovery-runtime.ts";
import { makeIncident, type RecoveryResult } from "./recovery.ts";

const finding = { id: "x", repo: "o/r", kind: "failing", url: "https://github.com/o/r/pull/1" };
const result: RecoveryResult = { category: "repository", outcome: "review", summary: "fixed", prUrls: ["https://github.com/o/r/pull/2"], tests: ["test"], deployedRevision: null, verification: [] };

test("durable queue deduplicates, records unavailable Codex, and preserves private settings", async () => {
  const dir = mkdtempSync("/var/tmp/watchdog-store-test-"); const prior = process.env.XDG_STATE_HOME; process.env.XDG_STATE_HOME = dir;
  try {
    assert.deepEqual(incidents(), []);
    const settings = { ...DEFAULTS.recovery, codexCommand: "/does/not/exist" };
    const incident = enqueue(finding, settings);
    assert.equal(incident.status, "blocked");
    assert.equal(enqueue(finding, settings).key, incident.key);
    assert.equal(incidents().length, 1);
    assert.equal(retryIncident(incident.key).status, "queued");
    assert.throws(() => retryIncident(incident.key), /blocked incident/);
    assert.equal(readIncident("../../config"), null);
    assert.equal(readIncident("missing"), null);
    rememberRecoverySettings(settings); assert.deepEqual(rememberedRecoverySettings(), settings);
    assert.equal(realpathSync(resolveExecutable("node")!), realpathSync(process.execPath));
    assert.equal(resolveExecutable("missing-tool", dir), null);
    incident.status = "resolved"; saveIncident(incident); assert.equal(enqueue(finding, settings).attempts, 0);
    const error = queueWatchdogFailure(new Error("failed https://secret.example/token"), settings);
    assert.doesNotMatch(error.finding.title!, /secret/);
  } finally { if (prior === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = prior; rmSync(dir, { recursive: true, force: true }); }
});

test("Codex executes with a structured result and non-owner fork instructions", async () => {
  const dir = mkdtempSync("/var/tmp/watchdog-codex-test-"); const prior = process.env.XDG_STATE_HOME; process.env.XDG_STATE_HOME = dir;
  try {
    const executable = path.join(dir, "codex");
    writeFileSync(executable, `#!${process.execPath}\nconst fs=require('node:fs');let p='';process.stdin.on('data',d=>p+=d);process.stdin.on('end',()=>{fs.writeFileSync(process.argv[process.argv.indexOf('--output-last-message')+1],JSON.stringify(${JSON.stringify(result)}));process.stdout.write(JSON.stringify({prompt:p})+'\\n');});`, { mode: 0o700 });
    const settings = { ...DEFAULTS.recovery, codexCommand: executable, workspaceRoot: path.join(dir, "work"), watchdogRepo: "owner/watchdog", watchdogCheckout: path.join(dir, "deployed"), allowWatchdogMerge: true };
    const incident = makeIncident(finding); incident.attempts = 1;
    assert.deepEqual(await executeCodex(incident, settings, async (_c, args) => args.includes("user") ? '{"login":"contributor"}' : '{"owner":{"login":"owner"}}'), result);
    const prompt = readFileSync(path.join(recoveryDirectory(), incident.key, incident.createdAt.replaceAll(":", "-"), "prompt-1.txt"), "utf8");
    assert.match(prompt, /allowWatchdogMerge=false/); assert.match(prompt, /FORK/); assert.match(prompt, /FIRST redeploy/);
    await assert.rejects(executeCodex(incident, { ...settings, codexCommand: "/missing" }), /unavailable/);
  } finally { if (prior === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = prior; rmSync(dir, { recursive: true, force: true }); }
});

test("a timed-out Codex result is rejected even when shutdown exits successfully", async () => {
  const dir = mkdtempSync("/var/tmp/watchdog-timeout-test-"); const prior = process.env.XDG_STATE_HOME; process.env.XDG_STATE_HOME = dir;
  try {
    const executable = path.join(dir, "codex");
    writeFileSync(executable, `#!${process.execPath}\nconst fs=require('node:fs');process.stdin.resume();process.on('SIGTERM',()=>{fs.writeFileSync(process.argv[process.argv.indexOf('--output-last-message')+1],JSON.stringify(${JSON.stringify(result)}));process.exit(0);});setInterval(()=>{},1000);`, { mode: 0o700 });
    const settings = { ...DEFAULTS.recovery, codexCommand: executable, timeoutMinutes: 0.02, workspaceRoot: path.join(dir, "work") };
    const incident = makeIncident(finding); incident.attempts = 1;
    await assert.rejects(executeCodex(incident, settings, async (_c, args) => args.includes("user") ? '{"login":"o"}' : '{"owner":{"login":"o"}}'), /exceeded its 0.02-minute deadline; private logs:/);
    const output = path.join(recoveryDirectory(), incident.key, incident.createdAt.replaceAll(":", "-"), "result-1.json");
    assert.deepEqual(JSON.parse(readFileSync(output, "utf8")), result);
    assert.equal(incident.pid, undefined);
  } finally { if (prior === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = prior; rmSync(dir, { recursive: true, force: true }); }
});

test("verification checks PR destination, state, CI, and fresh deployed scans", async () => {
  const incident = makeIncident(finding);
  const settings = { ...DEFAULTS.recovery, watchdogRepo: "o/watchdog", watchdogCheckout: "/opt/watchdog", allowWatchdogMerge: true };
  await verifyResult(incident, result, settings, async () => '{"state":"OPEN","statusCheckRollup":[]}');
  await assert.rejects(verifyResult(incident, { ...result, prUrls: ["https://github.com/wrong/repo/pull/2"] }, settings), /wrong repository/);
  await assert.rejects(verifyResult(incident, result, settings, async () => '{"state":"CLOSED","statusCheckRollup":[]}'), /not open/);
  await assert.rejects(verifyResult(incident, result, settings, async () => '{"state":"OPEN","statusCheckRollup":[{"conclusion":"FAILURE"}]}'), /failed checks/);
  const fixed: RecoveryResult = { ...result, category: "watchdog", outcome: "fixed", prUrls: ["https://github.com/o/watchdog/pull/2"], deployedRevision: "abc", verification: ["scan"] };
  await assert.rejects(verifyResult(incident, fixed, settings, async () => "other"), /revision/);
  await assert.rejects(verifyResult(incident, fixed, settings, async (_c, args) => args[0] === "rev-parse" ? "abc" : "dirty"), /uncommitted/);
  const scan = async (c: string, args: string[]) => {
    if (c === "git") return args[0] === "rev-parse" ? "abc" : "";
    if (c === "systemctl") return "/opt/watchdog/src/cli-watchdog.ts";
    if (c === "gh") return args.includes("user") ? '{"login":"o"}' : args[0] === "api" ? '{"owner":{"login":"o"}}' : '{"state":"MERGED","isCrossRepository":false,"mergeCommit":{"oid":"abc"}}';
    return '{"complete":true,"findings":[]}';
  };
  await verifyResult(incident, fixed, settings, scan);
  await assert.rejects(verifyResult(incident, { ...result, outcome: "resolved", verification: ["scan"] }, settings, async () => '{"complete":false,"findings":[]}'), /Independent/);
});

test("worker serializes jobs and recovers an interrupted investigation", async () => {
  const dir = mkdtempSync("/var/tmp/watchdog-worker-test-"); const prior = process.env.XDG_STATE_HOME; process.env.XDG_STATE_HOME = dir;
  try {
    const settings = { ...DEFAULTS.recovery, enabled: true };
    const incident = makeIncident(finding); incident.status = "investigating"; saveIncident(incident);
    await runRecovery({ settings, io: { save: saveIncident, notify: async () => {}, execute: async () => result, verify: async () => {} } });
    assert.equal(readIncident(incident.key)!.status, "review");
    const interrupted = makeIncident({ ...finding, id: "interrupted" });
    interrupted.status = "investigating"; interrupted.attempts = settings.maxAttempts; saveIncident(interrupted);
    await runRecovery({ settings, io: { save: saveIncident, notify: async () => {}, execute: async () => result, verify: async () => {} } });
    assert.equal(readIncident(interrupted.key)!.status, "blocked");
    assert.ok(readIncident(interrupted.key)!.error!.includes(path.join(recoveryDirectory(), interrupted.key)));
    await runRecovery({ settings: { ...settings, enabled: false } });
    mkdirSync(path.join(recoveryDirectory(), "worker.lock")); writeFileSync(path.join(recoveryDirectory(), "worker.lock", "pid"), String(process.pid));
    await runRecovery({ settings });
  } finally { if (prior === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = prior; rmSync(dir, { recursive: true, force: true }); }
});

test("terminal notifications are retried once without exposing secrets and fallback settings survive invalid config", async () => {
  const dir = mkdtempSync("/var/tmp/watchdog-notify-test-");
  const names = ["XDG_STATE_HOME", "DEP_WATCHDOG_CONFIG_DIR", "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID", "HEALTHCHECKS_PING_URL"];
  const before = Object.fromEntries(names.map((n) => [n, process.env[n]])); const oldFetch = globalThis.fetch;
  process.env.XDG_STATE_HOME = dir; process.env.DEP_WATCHDOG_CONFIG_DIR = path.join(dir, "config");
  process.env.TELEGRAM_BOT_TOKEN = "test-token"; process.env.TELEGRAM_CHAT_ID = "test-chat"; process.env.HEALTHCHECKS_PING_URL = "https://example.test";
  let calls = 0;
  globalThis.fetch = (async () => { calls++; return { ok: true }; }) as unknown as typeof fetch;
  try {
    const incident = makeIncident(finding); incident.status = "blocked"; saveIncident(incident);
    await notifyIncident(incident); await notifyIncident(incident); assert.equal(calls, 1);
    rememberRecoverySettings(DEFAULTS.recovery);
    await runRecovery();
    mkdirSync(path.join(dir, "config"));
    writeFileSync(path.join(dir, "config", "config.json"), JSON.stringify({ repos: ["o/r"] }));
    await runRecovery();
    writeFileSync(path.join(dir, "config", "config.json"), "{");
    await runRecovery();
  } finally {
    globalThis.fetch = oldFetch;
    for (const n of names) { if (before[n] === undefined) delete process.env[n]; else process.env[n] = before[n]; }
    rmSync(dir, { recursive: true, force: true });
  }
});


test("contributors must deploy locally and submit a fork PR; owners must deploy the merged revision", async () => {
  const incident = makeIncident(finding);
  const settings = { ...DEFAULTS.recovery, watchdogRepo: "o/watchdog", watchdogCheckout: "/opt/watchdog", allowWatchdogMerge: true };
  const repair: RecoveryResult = { ...result, category: "watchdog", prUrls: ["https://github.com/o/watchdog/pull/3"], deployedRevision: "abc", verification: ["locally deployed"] };
  const pr = { state: "OPEN", headRepositoryOwner: { login: "contributor" }, isCrossRepository: true, headRefOid: "abc", statusCheckRollup: [] };
  const runner = (patch = {}, start = "/opt/watchdog/src/cli-watchdog.ts") => async (c: string, args: string[]) => {
    if (c === "git") return args[0] === "rev-parse" ? "abc" : "";
    if (c === "systemctl") return start;
    if (c === "gh") return args.includes("user") ? '{"login":"contributor"}' : args[0] === "api" ? '{"owner":{"login":"o"}}' : JSON.stringify({ ...pr, ...patch });
    return '{"complete":true,"findings":[]}';
  };
  await verifyResult(incident, repair, settings, runner());
  await assert.rejects(verifyResult(incident, repair, settings, runner({ headRefOid: "older-commit" })), /exact locally verified/);
  await assert.rejects(verifyResult(incident, repair, settings, runner({ isCrossRepository: false })), /fork/);
  await assert.rejects(verifyResult(incident, repair, settings, runner({}, "/other/checkout")), /Installed/);
  await assert.rejects(verifyResult(incident, { ...repair, outcome: "fixed" }, settings, runner()), /Only the authorized/);
  await assert.rejects(verifyResult(incident, { ...repair, deployedRevision: null }, settings, runner()), /deployment evidence/);
});


test("review status follows subsequent CI failures and independently checks merged repairs", async () => {
  const incident = makeIncident(finding); incident.status = "review"; incident.result = { ...result }; incident.attempts = 1;
  await refreshReview(incident, DEFAULTS.recovery, async () => '{"state":"OPEN","statusCheckRollup":[{"conclusion":"FAILURE"}]}');
  assert.equal(incident.status, "queued");
  incident.status = "review"; incident.result = { ...result }; incident.attempts = 2;
  await refreshReview(incident, DEFAULTS.recovery, async () => '{"state":"OPEN","statusCheckRollup":[{"conclusion":"FAILURE"}]}');
  assert.equal(incident.status, "blocked");
  incident.status = "review"; incident.result = { ...result };
  await refreshReview(incident, DEFAULTS.recovery, async (c) => c === "gh" ? '{"state":"MERGED","statusCheckRollup":[]}' : '{"complete":true,"findings":[]}');
  assert.equal(incident.status, "resolved");
  incident.status = "review";
  await refreshReview(incident, DEFAULTS.recovery, async (c) => c === "gh" ? '{"state":"CLOSED","statusCheckRollup":[]}' : '{"complete":false,"findings":[]}');
  assert.equal(incident.status, "blocked");
});

test("a delayed reminder preserves a newer worker result and failed deliveries remain visible", async () => {
  const dir = mkdtempSync("/var/tmp/watchdog-delivery-test-");
  const names = ["XDG_STATE_HOME", "DEP_WATCHDOG_CONFIG_DIR", "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID", "HEALTHCHECKS_PING_URL"];
  const before = Object.fromEntries(names.map((n) => [n, process.env[n]])); const oldFetch = globalThis.fetch;
  process.env.XDG_STATE_HOME = dir; process.env.DEP_WATCHDOG_CONFIG_DIR = path.join(dir, "config");
  process.env.TELEGRAM_BOT_TOKEN = "test-token"; process.env.TELEGRAM_CHAT_ID = "test-chat"; process.env.HEALTHCHECKS_PING_URL = "https://example.test";
  try {
    const stale = makeIncident(finding); saveIncident(stale);
    const latest = { ...stale, status: "review" as const, result, attempts: 1 }; saveIncident(latest);
    globalThis.fetch = (async () => ({ ok: true })) as unknown as typeof fetch;
    await notifyIncident(stale, true);
    assert.equal(readIncident(stale.key)!.status, "review");
    assert.deepEqual(readIncident(stale.key)!.result, result);
    assert.equal(readIncident(stale.key)!.notifiedStatus, "queued");
    globalThis.fetch = async () => { throw new Error("telegram unavailable"); };
    await assert.rejects(notifyIncident(latest), /telegram unavailable/);
    assert.equal(readIncident(stale.key)!.notificationError, "telegram unavailable");
    assert.equal(readIncident(stale.key)!.notifiedStatus, "queued");
    globalThis.fetch = (async () => ({ ok: true })) as unknown as typeof fetch;
    await notifyIncident(latest);
    assert.equal(readIncident(stale.key)!.notifiedStatus, "review");
    assert.equal(readIncident(stale.key)!.notificationError, undefined);
  } finally {
    globalThis.fetch = oldFetch;
    for (const n of names) { if (before[n] === undefined) delete process.env[n]; else process.env[n] = before[n]; }
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a complete run resolves incidents whose findings are gone and leaves the rest alone", async () => {
  const dir = mkdtempSync("/var/tmp/watchdog-reconcile-test-"); const prior = process.env.XDG_STATE_HOME; process.env.XDG_STATE_HOME = dir;
  try {
    const blocked = makeIncident({ ...finding, id: "blocked-gone" }); blocked.status = "blocked"; blocked.error = "gave up";
    blocked.result = { ...result, outcome: "blocked", verification: ["earlier evidence"] }; saveIncident(blocked);
    const queued = makeIncident({ ...finding, id: "queued-gone" }); saveIncident(queued);
    const review = makeIncident({ ...finding, id: "review-present" }); review.status = "review"; review.result = { ...result }; saveIncident(review);
    const active = makeIncident({ ...finding, id: "investigating-gone" }); active.status = "investigating"; saveIncident(active);
    const notified: string[] = [];
    const notify = async (incident: typeof blocked): Promise<void> => { notified.push(incident.finding.id); if (incident.finding.id === "queued-gone") throw new Error("telegram down https://secret.example/token"); };
    await reconcileIncidents({ complete: false, findings: [] }, notify);
    assert.equal(readIncident(blocked.key)!.status, "blocked", "an incomplete run proves nothing");
    assert.deepEqual(notified, []);
    await reconcileIncidents({ complete: true, findings: [{ ...finding, id: "review-present" }] }, notify);
    const settled = readIncident(blocked.key)!;
    assert.equal(settled.status, "resolved");
    assert.equal(settled.error, undefined);
    assert.equal(settled.result!.outcome, "resolved");
    assert.match(settled.result!.summary, /no longer reports this finding; the incident was blocked/);
    assert.deepEqual(settled.result!.prUrls, result.prUrls, "the PR link survives for the operator");
    assert.deepEqual(settled.result!.verification, ["earlier evidence", "A complete watchdog run no longer reports this finding."]);
    assert.equal(readIncident(queued.key)!.status, "resolved");
    assert.equal(readIncident(queued.key)!.result!.category, "repository");
    assert.equal(readIncident(review.key)!.status, "review");
    assert.equal(readIncident(active.key)!.status, "investigating", "a running worker owns its incident");
    assert.deepEqual(notified.sort(), ["blocked-gone", "queued-gone"]);
  } finally { if (prior === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = prior; rmSync(dir, { recursive: true, force: true }); }
});

test("a private write that cannot land removes its temporary file", () => {
  const dir = mkdtempSync("/var/tmp/watchdog-write-test-");
  try {
    const target = path.join(dir, "incident.json");
    mkdirSync(target); writeFileSync(path.join(target, "child"), "occupied");
    assert.throws(() => writePrivate(target, { any: "value" }));
    assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith(".tmp")), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
