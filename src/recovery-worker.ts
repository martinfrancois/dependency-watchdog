import { validateResult, type Incident, type RecoveryResult } from "./recovery.ts";
import type { RecoverySettings } from "./types.ts";

export type WorkerIO = {
  save: (incident: Incident) => void;
  notify: (incident: Incident) => Promise<void>;
  execute: (incident: Incident, settings: RecoverySettings) => Promise<unknown>;
  verify: (incident: Incident, result: RecoveryResult, settings: RecoverySettings) => Promise<void>;
};
/** Each terminal result needs independent verification, not just the model's claim. */
export async function processIncident(incident: Incident, settings: RecoverySettings, io: WorkerIO): Promise<void> {
  if (incident.status !== "queued") return;
  incident.status = "investigating";
  io.save(incident);
  try { await io.notify(incident); } catch (error) {
    incident.notificationError = (error as Error).message;
    io.save(incident);
  }
  while (incident.attempts < settings.maxAttempts) {
    incident.attempts++;
    io.save(incident);
    try {
      const result = validateResult(await io.execute(incident, settings));
      if (result.outcome === "blocked") {
        incident.result = result; incident.error = result.summary; incident.status = "blocked";
        io.save(incident);
        break;
      }
      await io.verify(incident, result, settings);
      incident.result = result;
      incident.status = result.outcome === "review" ? "review" : "resolved";
      delete incident.error;
      io.save(incident);
      break;
    } catch (error) {
      incident.error = (error as Error).message;
      io.save(incident);
    }
  }
  if (incident.status === "investigating") incident.status = "blocked";
  io.save(incident);
  await io.notify(incident);
}
