import { execFile, spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { ConfigDirUnset, loadSettings, loadSecrets } from "./config.ts";
import { safeError } from "./diagnostics.ts";
import { sendTelegram } from "./notify.ts";
import { RESULT_SCHEMA, recoveryPrompt, statusMessage, type Incident, type RecoveryResult } from "./recovery.ts";
import { enqueue, incidents, readIncident, recoveryDirectory, rememberRecoverySettings, rememberedRecoverySettings, resolveExecutable, saveIncident, retryIncident, saveDelivery } from "./recovery-store.ts";
import { processIncident } from "./recovery-worker.ts";
import type { Finding, RecoverySettings } from "./types.ts";

const exec = promisify(execFile);
const command = async (cmd: string, args: string[], cwd?: string): Promise<string> =>
  (await exec(cmd, args, { ...(cwd ? { cwd } : {}), timeout: 180_000, maxBuffer: 32 * 1024 * 1024 })).stdout.trim();

export async function notifyIncident(incident: Incident, reminder = false): Promise<void> {
  if (!reminder && incident.notifiedStatus === incident.status) return;
  try { await sendTelegram(loadSecrets(), statusMessage(incident)); }
  catch (error) {
    incident.notificationError = (error as Error).message;
    saveDelivery(incident, incident.notificationError);
    throw error;
  }
  delete incident.notificationError;
  incident.notifiedStatus = incident.status;
  saveDelivery(incident);
}
export function queueWatchdogFailure(error: unknown, settings: RecoverySettings): Incident {
  return enqueue({ id: `watchdog-failure:${settings.watchdogRepo}`, kind: "dependency watchdog could not complete a run",
    repo: settings.watchdogRepo, url: `https://github.com/${settings.watchdogRepo}`, title: String(error instanceof Error ? error.message : error).replace(/https?:\/\/\S+/g, "<redacted-url>") }, settings);
}
function attemptDirectory(incident: Incident): string {
  return path.join(recoveryDirectory(), incident.key, incident.createdAt.replaceAll(":", "-"));
}
export async function executeCodex(incident: Incident, settings: RecoverySettings, run = command): Promise<unknown> {
  const executable = resolveExecutable(settings.codexCommand);
  if (!executable) throw new Error("Codex is unavailable on the worker PATH");
  const dir = attemptDirectory(incident);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const workspace = path.join(settings.workspaceRoot, incident.key);
  mkdirSync(workspace, { recursive: true, mode: 0o700 });
  const account = JSON.parse(await run("gh", ["api", "user"])) as { login: string };
  const repository = JSON.parse(await run("gh", ["api", `repos/${settings.watchdogRepo}`])) as { owner: { login: string } };
  const maintainer = account.login.toLowerCase() === repository.owner.login.toLowerCase();
  const effective = { ...settings, workspaceRoot: workspace, allowWatchdogMerge: settings.allowWatchdogMerge && maintainer };
  const prompt = recoveryPrompt(incident, effective) + `\nAuthenticated GitHub account: ${account.login}. Upstream owner: ${repository.owner.login}. Maintainer mode: ${maintainer}.\n`;
  const schema = path.join(dir, "schema.json");
  const result = path.join(dir, `result-${incident.attempts}.json`);
  writeFileSync(schema, JSON.stringify(RESULT_SCHEMA), { mode: 0o600 });
  writeFileSync(path.join(dir, `prompt-${incident.attempts}.txt`), prompt, { mode: 0o600 });
  await new Promise<void>((resolve, reject) => {
    const log = createWriteStream(path.join(dir, `codex-${incident.attempts}.jsonl`), { mode: 0o600 });
    const errors = createWriteStream(path.join(dir, `codex-${incident.attempts}.stderr`), { mode: 0o600 });
    const child = spawn(executable, ["exec", "--json", "--sandbox", "danger-full-access", "-c", 'approval_policy="never"', "--skip-git-repo-check", "-C", workspace, "--output-schema", schema, "--output-last-message", result, "-"], {
      detached: true, env: { ...process.env, DEP_WATCHDOG_RECOVERY: "1" }, stdio: ["pipe", "pipe", "pipe"],
    });
    if (child.pid !== undefined) incident.pid = child.pid;
    saveIncident(incident);
    child.stdout.pipe(log); child.stderr.pipe(errors);
    child.stdin.end(prompt);
    const stop = (signal: NodeJS.Signals): void => {
      if (child.pid) { try { process.kill(-child.pid, signal); } catch {} }
    };
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; stop("SIGTERM"); }, settings.timeoutMinutes * 60_000);
    const killTimer = setTimeout(() => stop("SIGKILL"), settings.timeoutMinutes * 60_000 + 10_000);
    child.once("error", (error) => { clearTimeout(timer); clearTimeout(killTimer); log.end(); errors.end(); reject(error); });
    child.once("close", (code, signal) => {
      clearTimeout(timer); clearTimeout(killTimer); log.end(); errors.end(); delete incident.pid;
      if (timedOut) reject(new Error(`Codex exceeded its ${settings.timeoutMinutes}-minute deadline; private logs: ${dir}`));
      else if (code === 0) resolve(); else reject(new Error(`Codex exited ${code ?? signal}; private logs: ${dir}`));
    });
  });
  return JSON.parse(readFileSync(result, "utf8"));
}
type PullRequest = { state: string; statusCheckRollup: { conclusion?: string; state?: string }[];
  isCrossRepository: boolean; headRepositoryOwner: { login: string }; headRefOid: string; mergeCommit: { oid: string } | null };
export async function verifyResult(incident: Incident, result: RecoveryResult, settings: RecoverySettings, run = command): Promise<void> {
  const watchdogRepair = result.category === "watchdog" && ["fixed", "review"].includes(result.outcome);
  if (watchdogRepair) {
    if (!result.deployedRevision || !result.verification.length) throw new Error("Watchdog repair lacks local deployment evidence");
    const sha = await run("git", ["rev-parse", "HEAD"], settings.watchdogCheckout);
    if (sha !== result.deployedRevision) throw new Error("Claimed deployment revision differs from the running checkout");
    if (await run("git", ["status", "--porcelain"], settings.watchdogCheckout)) throw new Error("Deployed checkout contains uncommitted changes");
    const start = await run("systemctl", ["--user", "show", "dep-watchdog.service", "--property=ExecStart", "--value"]);
    if (!start.includes(path.join(settings.watchdogCheckout, "src/cli-watchdog.ts"))) throw new Error("Installed watchdog service does not run the claimed checkout");
  }
  if (["fixed", "review"].includes(result.outcome)) {
    let account = "", owner = "";
    if (watchdogRepair) {
      account = (JSON.parse(await run("gh", ["api", "user"])) as { login: string }).login.toLowerCase();
      owner = (JSON.parse(await run("gh", ["api", `repos/${settings.watchdogRepo}`])) as { owner: { login: string } }).owner.login.toLowerCase();
      if (result.outcome === "fixed" && (!settings.allowWatchdogMerge || account !== owner)) throw new Error("Only the authorized upstream owner may report a merged watchdog fix");
    }
    for (const url of result.prUrls) {
      const expected = result.category === "watchdog" ? settings.watchdogRepo : incident.finding.repo;
      if (!url.startsWith(`https://github.com/${expected}/pull/`)) throw new Error("PR targets the wrong repository");
      const pr = JSON.parse(await run("gh", ["pr", "view", url, "--json", "state,url,headRefOid,statusCheckRollup,isCrossRepository,headRepositoryOwner,mergeCommit"])) as PullRequest;
      if (result.outcome === "review") {
        if (pr.state !== "OPEN") throw new Error("Review PR is not open");
        if (pr.statusCheckRollup.some((c) => ["FAILURE", "ERROR", "TIMED_OUT", "ACTION_REQUIRED", "CANCELLED"].includes((c.conclusion ?? c.state ?? "").toUpperCase()))) throw new Error("Review PR still has failed checks");
        if (watchdogRepair) {
          if (pr.headRepositoryOwner.login.toLowerCase() !== account || (account !== owner && !pr.isCrossRepository)) throw new Error("Non-owner watchdog repairs require a PR from the authenticated account's fork");
          if (pr.headRefOid !== result.deployedRevision) throw new Error("Review PR does not contain the exact locally verified deployment revision");
        }
      } else if (pr.state !== "MERGED" || pr.isCrossRepository || pr.mergeCommit?.oid !== result.deployedRevision) {
        throw new Error("Maintainer repair must deploy its merged same-repository PR revision");
      }
    }
    if (result.category === "repository") return;
  }
  const report = JSON.parse(await run(process.execPath, [path.join(settings.watchdogCheckout, "src/cli-watchdog.ts"), "--json"], settings.watchdogCheckout)) as { complete: boolean; findings: Finding[] };
  if (!report.complete || report.findings.some((f) => f.id === incident.finding.id)) throw new Error("Independent scan still reports the incident or incomplete coverage");
  result.verification.push("Worker independently reran the deployed watchdog and verified the incident is absent.");
}
export async function refreshReview(incident: Incident, settings: RecoverySettings, run = command): Promise<void> {
  if (incident.status !== "review" || !incident.result?.prUrls.length) return;
  const prs: PullRequest[] = [];
  for (const url of incident.result.prUrls) prs.push(JSON.parse(await run("gh", ["pr", "view", url, "--json", "state,statusCheckRollup"])) as PullRequest);
  if (prs.some((pr) => pr.state === "OPEN")) {
    if (prs.some((pr) => pr.state === "OPEN" && pr.statusCheckRollup.some((c) => ["FAILURE", "ERROR", "TIMED_OUT", "ACTION_REQUIRED"].includes(c.conclusion ?? c.state ?? "")))) {
      incident.status = incident.attempts < settings.maxAttempts ? "queued" : "blocked";
      incident.error = "The review PR has failing checks; the proposed repair needs further work.";
      delete incident.result;
    }
    return;
  }
  try {
    await verifyResult(incident, { ...incident.result, outcome: "resolved" }, settings, run);
    incident.status = "resolved";
    incident.result.summary = "The review PR is closed and an independent scan confirms the incident is addressed.";
  } catch (error) {
    incident.status = "blocked";
    incident.error = `The review PR closed without resolving the incident: ${(error as Error).message}`;
    delete incident.result;
  }
}
/**
 * A complete run that no longer reports a finding closes its incident, whatever left it open.
 *
 * Blocked incidents used to stay red forever once the operator fixed the problem by hand, because
 * only review PRs were followed. The finding's absence from a complete scan is the same evidence
 * the worker demands from Codex, so the incident is resolved on it and the operator is told once.
 */
export async function reconcileIncidents(report: { complete: boolean; findings: Finding[] }, notify = notifyIncident): Promise<void> {
  if (!report.complete) return;
  const present = new Set(report.findings.map((f) => f.id));
  for (const incident of incidents()) {
    if (["investigating", "resolved"].includes(incident.status) || present.has(incident.finding.id)) continue;
    incident.result = {
      category: "repository", prUrls: [], tests: [], deployedRevision: null, ...incident.result, outcome: "resolved",
      summary: `A complete watchdog run no longer reports this finding; the incident was ${incident.status} and is now closed.`,
      verification: [...(incident.result?.verification ?? []), "A complete watchdog run no longer reports this finding."],
    };
    incident.status = "resolved";
    delete incident.error;
    saveIncident(incident);
    try { await notify(incident); } catch (error) { console.error(safeError(error)); }
  }
}
function readRecoverySettings(): RecoverySettings {
  try {
    const settings = loadSettings().recovery;
    rememberRecoverySettings(settings);
    return settings;
  } catch (error) {
    if (error instanceof ConfigDirUnset) throw error;
    return rememberedRecoverySettings();
  }
}
function processAlive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch { return false; } }
export async function runRecovery(options: { settings?: RecoverySettings; io?: import("./recovery-worker.ts").WorkerIO } = {}): Promise<void> {
  if (process.argv.includes("--status")) { console.log(JSON.stringify(incidents(), null, 2)); return; }
  const settings = options.settings ?? readRecoverySettings();
  if (!settings.enabled) return;
  const retry = process.argv.indexOf("--retry");
  if (retry !== -1) retryIncident(process.argv[retry + 1] ?? "");
  if (process.argv.includes("--watchdog-failure")) queueWatchdogFailure("systemd reported a failed watchdog or prune service; inspect both journals and last-prune.json", settings);
  const lock = path.join(recoveryDirectory(), "worker.lock");
  mkdirSync(recoveryDirectory(), { recursive: true, mode: 0o700 });
  try { mkdirSync(lock); } catch {
    const pidFile = path.join(lock, "pid");
    if (existsSync(pidFile) ? processAlive(Number(readFileSync(pidFile, "utf8"))) : Date.now() - statSync(lock).mtimeMs < 60_000) return;
    rmSync(lock, { recursive: true });
    mkdirSync(lock);
  }
  writeFileSync(path.join(lock, "pid"), String(process.pid), { mode: 0o600 });
  try {
    for (const pending of incidents()) {
      const incident = readIncident(pending.key)!;
      if (incident.status === "investigating") {
        if (incident.pid && processAlive(incident.pid)) continue;
        incident.status = incident.attempts < settings.maxAttempts ? "queued" : "blocked";
        incident.error = `The previous worker stopped before returning a verified result; private logs: ${attemptDirectory(incident)}`;
        saveIncident(incident);
      }
      if (incident.status === "review" && !options.io) {
        await refreshReview(incident, settings);
        saveIncident(incident);
      }
      if (incident.status === "queued") {
        await processIncident(incident, settings, options.io ?? { save: saveIncident, notify: notifyIncident, execute: executeCodex, verify: verifyResult });
      } else await (options.io?.notify ?? notifyIncident)(incident);
    }
  } finally { rmSync(lock, { recursive: true, force: true }); }
}
