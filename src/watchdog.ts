#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import path from "node:path";

import { ConfigDirUnset, loadSecrets, loadSettings, statePath } from "./config.ts";
import { inspect, deliver, safeError, type Report } from "./diagnostics.ts";
import { pingHealthchecks, sendTelegram } from "./notify.ts";
import { enqueue, rememberRecoverySettings } from "./recovery-store.ts";
import { notifyIncident, queueWatchdogFailure, reconcileIncidents } from "./recovery-runtime.ts";
import type { Finding, State } from "./types.ts";


export function isReadOnly(): boolean {
  return process.argv.includes("--dry-run") || process.argv.includes("--json");
}

/**
 * Read the state file, treating anything unreadable as a fresh start.
 *
 * A corrupt or missing state file must not stop the run: the cost is re-reporting problems that
 * are already open, which is noisy once. Refusing to run would mean reporting nothing at all,
 * which is the failure this whole project exists to prevent.
 */
export function loadState(): State {
  try {
    const state = JSON.parse(readFileSync(statePath(), "utf8")) as State;
    if (!state || !state.seen || typeof state.seen !== "object" || Array.isArray(state.seen)
      || Object.values(state.seen).some((value) => !value || !Number.isFinite(value.first)
        || (value.notified !== null && !Number.isFinite(value.notified)))) {
      throw new Error("invalid state schema");
    }
    return state;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.error(JSON.stringify({ event: "state_reset", reason: safeError(error) }));
    return { seen: {} };
  }
}

export function saveState(state: State): void {
  const file = statePath();
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(`${file}.tmp`, JSON.stringify(state, null, 1), { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
}

export { decideNotifications } from "./diagnostics.ts";

/** Everything a message needs to be actionable without opening a browser first. */
export async function render(finding: Finding): Promise<string> {
  // Not every finding has an age: a broken branch is a state, not a duration.
  const head = finding.ageText ? `🔴 STUCK ${finding.ageText}: ` : "🔴 ";
  const lines = [`${head}${finding.kind}`, ""];
  lines.push(`repo   ${finding.repo}`);
  lines.push(`id     ${finding.id}`);
  if (finding.sha) lines.push(`head   ${finding.sha}`);
  if (finding.number) lines.push(`pr     #${finding.number}  ${finding.url}`);
  else lines.push(`link   ${finding.url}`);
  if (finding.title) lines.push(`title  ${finding.title}`);
  if (finding.opened) {
    lines.push(`opened ${finding.opened}  (threshold ${finding.threshold})`);
  } else if (finding.last) {
    lines.push(`last   ${finding.last}  (threshold ${finding.threshold})`);
  }

  if (finding.failing?.length) {
    lines.push("", "blocked by");
    for (const f of finding.failing) {
      lines.push(`  check "${f.name}" conclusion=${f.conclusion}`);
      if (f.url) lines.push(`  ${f.url}`);
    }
  }

  if (finding.brokenSince?.length) {
    lines.push("", `failing since (${finding.threshold})`);
    for (const c of finding.brokenSince.slice(0, 8)) {
      lines.push(`  ${c.sha.slice(0, 8)}  ${c.message.slice(0, 60)}`);
    }
    if (finding.brokenSince.length > 8) {
      lines.push(`  … and ${finding.brokenSince.length - 8} more`);
    }
  }

  if (finding.entries?.length) {
    lines.push("", `matured entries in ${finding.file}`);
    for (const e of finding.entries.slice(0, 12)) lines.push(`  ${e}`);
    if (finding.entries.length > 12) {
      lines.push(`  … and ${finding.entries.length - 12} more`);
    }
  }


  lines.push("", "reproduce");
  if (finding.brokenSince?.length) {
    lines.push(`  gh run list --repo ${finding.repo} --commit ${finding.sha} --limit 5`);
    lines.push(`  git -C <clone> log --oneline ${finding.sha}~1..HEAD`);
    return lines.join("\n");
  }
  // Matured exclusions have no pull request either; the remedy is the prune, so say so.
  if (finding.entries?.length) {
    lines.push(
      `  gh api repos/${finding.repo}/contents/${finding.file} -H "Accept: application/vnd.github.raw"`,
    );
    lines.push(`  node src/cli-prune.ts --dry-run   # from this checkout; the prune removes these`);
    return lines.join("\n");
  }

  // Only emit a pull request command when there is a pull request. Interpolating an empty number
  // produced "gh pr view  --repo ..." which does nothing but waste the reader's time, and the
  // whole point of these messages is that they can be pasted somewhere and run.
  if (finding.number) {
    lines.push(`  gh pr view ${finding.number} --repo ${finding.repo}`);
    lines.push(`  gh pr checks ${finding.number} --repo ${finding.repo}`);
  } else {
    lines.push(`  gh repo view ${finding.repo} --web`);
  }
  return lines.join("\n");
}

export function saveReport(report: Report): void {
  const file = path.join(path.dirname(statePath()), "last-run.json");
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(`${file}.tmp`, JSON.stringify(report, null, 2), { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
}

export async function runWatchdog(): Promise<void> {
  const settings = loadSettings();
  const readOnly = isReadOnly();
  const report = await inspect(settings, loadState());
  if (readOnly) {
    if (process.argv.includes("--json")) console.log(JSON.stringify(report, null, 2));
    else {
      console.log(`findings: ${report.findings.length}, would notify: ${report.notifications.length}`);
      for (const finding of report.findings) {
        const decision = report.decisions.find((d) => d.id === finding.id)!;
        console.log(`\n${await render(finding)}\nnotification: ${decision.reason}`);
      }
      for (const check of report.checks.filter((c) => c.status === "error")) {
        console.error(`${check.repo} ${check.check}: ${check.error}`);
      }
    }
    if (!report.complete) process.exitCode = 1;
    return;
  }
  const secrets = loadSecrets();
  const recover = settings.recovery.enabled && process.env.DEP_WATCHDOG_RECOVERY !== "1";
  if (recover) rememberRecoverySettings(settings.recovery);
  saveReport(report);
  for (const check of report.checks) console.log(JSON.stringify({ event: "check", runId: report.runId, ...check }));
  for (const finding of report.findings) console.log(JSON.stringify({ event: "finding", runId: report.runId, finding, decision: report.decisions.find((d) => d.id === finding.id) }));
  // Before delivery: a notifier outage stops delivery early, and closing incidents must not wait on it.
  if (recover) await reconcileIncidents(report);
  try {
    await deliver(report, async (finding) => {
      if (recover) {
        const incident = enqueue(finding, settings.recovery);
        await notifyIncident(incident, true);
      } else await sendTelegram(secrets, await render(finding));
    }, saveState);
  } finally {
    saveReport(report);
    console.log(JSON.stringify({ event: "run", runId: report.runId, complete: report.complete, findings: report.findings.length, decisions: report.decisions, delivery: report.delivery }));
  }
  if (!report.complete) throw new Error("Incomplete watchdog coverage; see last-run.json");
  await pingHealthchecks(secrets);
}

export async function handleFailure(error: unknown): Promise<void> {
  console.error(safeError(error));
  // Without a configuration directory there is no channel to notify and no heartbeat to fail.
  if (!isReadOnly() && !(error instanceof ConfigDirUnset)) {
    if (process.env.DEP_WATCHDOG_RECOVERY !== "1") {
      try {
        const settings = loadSettings().recovery;
        if (settings.enabled) await notifyIncident(queueWatchdogFailure(error, settings));
      } catch (recoveryError) { console.error(safeError(recoveryError)); }
    }
    await pingHealthchecks(loadSecrets({ required: false }), { failed: true });
  }
  process.exitCode = 1;
}
