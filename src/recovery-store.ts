import { randomUUID } from "node:crypto";
import { accessSync, constants, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { statePath } from "./config.ts";
import { makeIncident, shouldQueue, type Incident } from "./recovery.ts";
import type { Finding, RecoverySettings } from "./types.ts";

export function recoveryDirectory(): string { return path.join(path.dirname(statePath()), "recovery"); }
export function writePrivate(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
    renameSync(temporary, file);
  } catch (error) {
    // A failed rename must not leave its temporary behind; a full disk produced one per minute.
    rmSync(temporary, { force: true });
    throw error;
  }
}
export function saveIncident(incident: Incident): void {
  incident.updatedAt = new Date().toISOString();
  writePrivate(path.join(recoveryDirectory(), `${incident.key}.json`), incident);
}
export function readIncident(key: string): Incident | null {
  if (!/^[a-f0-9]{32}$/.test(key)) return null;
  const file = path.join(recoveryDirectory(), `${key}.json`);
  if (!existsSync(file)) return null;
  const incident = JSON.parse(readFileSync(file, "utf8")) as Incident;
  const delivery = readDelivery(key);
  if (delivery?.generation === incident.createdAt) {
    if (delivery.status) incident.notifiedStatus = delivery.status;
    if (delivery.error) incident.notificationError = delivery.error;
    else delete incident.notificationError;
  }
  return incident;
}
export function incidents(): Incident[] {
  if (!existsSync(recoveryDirectory())) return [];
  return readdirSync(recoveryDirectory()).filter((f) => /^[a-f0-9]{32}\.json$/.test(f))
    .map((f) => readIncident(f.slice(0, -5))!);
}
export function resolveExecutable(command: string, searchPath = process.env.PATH ?? ""): string | null {
  const candidates = command.includes(path.sep) ? [command] : searchPath.split(path.delimiter).map((dir) => path.join(dir, command));
  for (const file of candidates) {
    try { accessSync(file, constants.X_OK); return file; } catch {}
  }
  return null;
}
export function enqueue(finding: Finding, settings: RecoverySettings): Incident {
  const incident = makeIncident(finding);
  const existing = readIncident(incident.key);
  if (!shouldQueue(existing, finding)) return existing!;
  if (!resolveExecutable(settings.codexCommand)) {
    incident.status = "blocked";
    incident.error = "Codex is not installed or is not executable on the service PATH.";
  }
  saveIncident(incident);
  return incident;
}
export function rememberRecoverySettings(settings: RecoverySettings): void {
  writePrivate(path.join(recoveryDirectory(), "settings.json"), settings);
}
export function rememberedRecoverySettings(): RecoverySettings {
  return JSON.parse(readFileSync(path.join(recoveryDirectory(), "settings.json"), "utf8")) as RecoverySettings;
}

export function retryIncident(key: string): Incident {
  const incident = readIncident(key);
  if (!incident || incident.status !== "blocked") throw new Error("Retry requires a blocked incident key from --status");
  writePrivate(path.join(recoveryDirectory(), key, `history-${incident.updatedAt.replaceAll(":", "-")}.json`), incident);
  const next = makeIncident(incident.finding);
  saveIncident(next);
  return next;
}

type Delivery = { generation: string; status?: string; error?: string };
function readDelivery(key: string): Delivery | null {
  const file = path.join(recoveryDirectory(), `${key}.delivery.json`);
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) as Delivery : null;
}
/** Notification acknowledgements must not overwrite a worker's newer state. */
export function saveDelivery(incident: Incident, error?: string): void {
  const prior = readDelivery(incident.key);
  const status = error ? (prior?.generation === incident.createdAt ? prior.status : incident.notifiedStatus) : incident.status;
  writePrivate(path.join(recoveryDirectory(), `${incident.key}.delivery.json`), { generation: incident.createdAt, ...(status ? { status } : {}), ...(error ? { error } : {}) });
}
