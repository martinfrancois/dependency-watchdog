import { readFileSync, readdirSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { automergePrsFailing, defaultBranchBroken, refreshMissing, securityPrsStuck, staleExclusions, defaultDeps, type Deps } from "./checks.ts";
import type { Checks, CheckRun, Finding, Settings, State } from "./types.ts";

type Evidence = { source: string; args: unknown[]; value: unknown };
type CheckRecord = {
  repo: string; check: keyof Checks; status: "completed" | "disabled" | "error";
  durationMs: number; findingIds: string[]; evidence: Evidence[]; error?: string; assessment?: string;
};
export type Report = {
  schemaVersion: 1; sourceDigest: string; runId: string; startedAt: string; finishedAt: string;
  complete: boolean; settings: Settings; checks: CheckRecord[]; findings: Finding[];
  decisions: { id: string; reason: "confirming" | "initial" | "reminder" | "cooldown" | "awaiting-prune"; nextEligibleAt?: string }[];
  notifications: Finding[]; resolved: string[]; nextState: State;
  delivery: Record<string, "sent" | "failed">;
};

/** Keep credentials in URLs and terminal control bytes out of saved diagnostics. */
export function safeError(error: unknown): string {
  return String(error instanceof Error ? error.message : error)
    .replace(/https?:\/\/[^\s]+/g, "<redacted-url>")
    .replace(/[\u0000-\u001f\u007f]/g, "");
}

/** Inspect every configured check. A failed observation is never a resolution. */
export async function inspect(settings: Settings, original: State, deps: Deps = defaultDeps): Promise<Report> {
  const now = Date.now();
  const state = structuredClone(original);
  const findings: Finding[] = [];
  const checks: CheckRecord[] = [];
  const failedRepos = new Set<string>();
  const cache = new Map<string, Promise<unknown>>();
  let evidence: Evidence[] = [];
  const observed = Object.fromEntries(Object.entries(deps).map(([source, fn]) => [source,
    async (...args: unknown[]) => {
      const key = JSON.stringify([source, args]);
      if (!cache.has(key)) cache.set(key, Promise.resolve().then(() => (fn as (...a: unknown[]) => unknown)(...args)));
      const value = await cache.get(key);
      const summary = source === "fileContents" ? { present: value !== null }
        : source === "openPullRequests" ? (value as { number: number; title: string; head: unknown; created_at: string }[]).map(({ number, title, head, created_at }) => ({ number, title, head, created_at }))
        : value;
      evidence.push({ source, args, value: summary });
      return value;
    },
  ])) as Deps;
  const implementations: Record<keyof Checks, (repo: string) => Promise<Finding[]>> = {
    securityPrs: (r) => securityPrsStuck(r, settings, observed),
    failingPrs: (r) => automergePrsFailing(r, settings, observed),
    lockfileRefresh: (r) => refreshMissing(r, settings, null, observed),
    staleExclusions: (r) => staleExclusions(r, settings, observed),
    defaultBranchBroken: async (r) => {
      const metadata = await observed.gh<{ default_branch: string }>(`repos/${r}`);
      return defaultBranchBroken(r, { ...settings, defaultBranch: metadata.default_branch }, observed);
    },
  };
  for (const repo of settings.repos) {
    for (const check of Object.keys(implementations) as (keyof Checks)[]) {
      evidence = [];
      const start = Date.now();
      const record: CheckRecord = { repo, check, status: "disabled", durationMs: 0, findingIds: [], evidence };
      if (settings.checks[check]) {
        try {
          const found = await implementations[check](repo);
          findings.push(...found);
          record.findingIds = found.map((f) => f.id);
          record.status = "completed";
          if (check === "lockfileRefresh") record.assessment = found.length
            ? "overdue maintenance PR" : "no separate maintenance alert; absence of a PR does not establish scheduler health";
          if (check === "defaultBranchBroken") {
            const headChecks = evidence.find((e) => e.source === "checkStatus")?.value as CheckRun[] | undefined;
            record.assessment = found.length ? "failing head with dependency changes in observed history"
              : !headChecks?.length ? "no checks observed on current head; branch health unknown"
                : "no dependency-related branch finding; inspect check evidence for pending or skipped CI";
          }
        } catch (error) {
          failedRepos.add(repo);
          record.status = "error";
          record.error = safeError(error);
        }
      }
      record.durationMs = Date.now() - start;
      checks.push(record);
    }
  }
  const before = structuredClone(state);
  const notifications = decideNotifications(findings, state, now, settings.thresholds.escalateAfterDays, settings.thresholds.exclusionGraceDays);
  for (const [id, prior] of Object.entries(before.seen)) {
    if (!findings.some((f) => f.id === id) && [...failedRepos].some((repo) => id.includes(`${repo}#`) || id.endsWith(`:${repo}`) || id.includes(`${repo}:`))) {
      // A confirmed incident survives an outage. An unconfirmed sighting needs two fresh runs.
      if (prior.notified !== null) state.seen[id] = prior;
    }
  }
  const due = new Set(notifications.map((f) => f.id));
  const decisions: Report["decisions"] = findings.map((f) => {
    const prev = before.seen[f.id];
    const awaitingPrune = f.id.startsWith("stale-exclusions:") && now - (prev?.first ?? now) < settings.thresholds.exclusionGraceDays * 86400_000;
    const reason = awaitingPrune ? "awaiting-prune" : due.has(f.id) ? (prev?.notified ? "reminder" : "initial") : prev?.notified ? "cooldown" : "confirming";
    return { id: f.id, reason, ...(prev?.notified ? { nextEligibleAt: new Date(prev.notified + settings.thresholds.escalateAfterDays * 86400_000).toISOString() } : {}) };
  });
  // A decision to send is not a delivery acknowledgement.
  for (const f of notifications) state.seen[f.id]!.notified = before.seen[f.id]?.notified ?? null;
  return {
    schemaVersion: 1, sourceDigest: sourceDigest(), runId: randomUUID(), startedAt: new Date(now).toISOString(), finishedAt: new Date().toISOString(),
    complete: failedRepos.size === 0, settings, checks, findings, decisions, notifications,
    resolved: Object.keys(before.seen).filter((id) => !state.seen[id] && ![...failedRepos].some((repo) => id.includes(`${repo}#`) || id.endsWith(`:${repo}`) || id.includes(`${repo}:`))), nextState: state, delivery: {},
  };
}

/** Checkpoint each delivered message so a later send failure does not repeat earlier messages. */
export async function deliver(report: Report, send: (finding: Finding) => Promise<void>, save: (state: State) => void): Promise<void> {
  save(report.nextState);
  for (const finding of report.notifications) {
    try {
      await send(finding);
      report.nextState.seen[finding.id]!.notified = Date.now();
      save(report.nextState);
      report.delivery[finding.id] = "sent";
    } catch (error) {
      report.delivery[finding.id] = "failed";
      throw error;
    }
  }
}

export function decideNotifications(
  findings: Finding[],
  state: State,
  now: number,
  escalateAfterDays: number,
  exclusionGraceDays = 7,
): Finding[] {
  const current = new Set(findings.map((f) => f.id));
  const toSend: Finding[] = [];

  for (const finding of findings) {
    const prev = state.seen[finding.id];
    if (!prev) {
      state.seen[finding.id] = { first: now, notified: null };
      continue;
    }
    if (finding.id.startsWith("stale-exclusions:") && now - prev.first < exclusionGraceDays * 86400_000) continue;
    if (!prev.notified) {
      toSend.push(finding);
      prev.notified = now;
      continue;
    }
    if (now - prev.notified >= escalateAfterDays * 86400_000) {
      toSend.push({ ...finding, kind: `${finding.kind} (still open)` });
      prev.notified = now;
    }
  }

  for (const id of Object.keys(state.seen)) {
    if (!current.has(id)) delete state.seen[id];
  }
  return toSend;
}


/** Identify checked-in runtime sources, including local changes before a commit. */
export function sourceDigest(): string {
  const hash = createHash("sha256");
  for (const file of readdirSync(new URL(".", import.meta.url)).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts")).sort()) {
    hash.update(file).update("\0").update(readFileSync(new URL(file, import.meta.url))).update("\0");
  }
  return hash.digest("hex");
}
