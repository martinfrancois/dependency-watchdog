import { readFileSync } from "node:fs";
import type { Secrets, Settings } from "./types.ts";
import { homedir } from "node:os";
import path from "node:path";

/**
 * Paths are resolved per call rather than at import time.
 *
 * Reading the environment once at import would mean a test could only change it by re-importing
 * the module under a cache-busting URL, which works but makes every call look uncovered, because
 * coverage is attributed per module URL. Resolving lazily keeps the module a single instance and
 * lets a caller point it somewhere else between calls.
 */
export function configDir(): string {
  const dir = process.env.DEP_WATCHDOG_CONFIG_DIR;
  if (dir) return dir;
  const xdgConfig = process.env.XDG_CONFIG_HOME || path.join(homedir(), ".config");
  throw new ConfigDirUnset(
    `DEP_WATCHDOG_CONFIG_DIR is not set. Point it at the directory holding config.json and ` +
      `config.env, for example ${path.join(xdgConfig, "dep-watchdog")}.`,
  );
}

export class ConfigDirUnset extends Error {}

export function secretsPath(): string {
  return path.join(configDir(), "config.env");
}

export function settingsPath(): string {
  return path.join(configDir(), "config.json");
}

export function statePath(): string {
  const xdgState =
    process.env.XDG_STATE_HOME || path.join(homedir(), ".local", "state");
  return path.join(xdgState, "dep-watchdog", "state.json");
}

/**
 * Defaults for everything that is not a secret.
 *
 * Chosen so that a first run is useful without tuning, and so that each threshold answers "would
 * you act on this?" with yes. Raising them is safe; lowering them is how a notification channel
 * becomes something you swipe away.
 */
export const DEFAULTS: Settings = {
  repos: [],
  recovery: {
    enabled: false, codexCommand: "codex", watchdogRepo: "", watchdogCheckout: "",
    workspaceRoot: "/var/tmp/dep-watchdog-recovery", timeoutMinutes: 90, maxAttempts: 2,
    allowWatchdogMerge: false,
  },
  /** Path to the pnpm settings file, relative to the repo root. Per-repo overrides below. */
  workspaceFile: "pnpm-workspace.yaml",
  workspaceFiles: {},
  /** Identity for commits the prune makes. Must be set before the prune will push. */
  commitName: null,
  commitEmail: null,
  /** Legacy default-branch fallback for direct check callers. Inspection reads repository metadata. */
  defaultBranch: "main",
  thresholds: {
    /** Hours a security pull request may stay open before it is worth interrupting you. */
    securityPrHours: 48,
    /** Days a dependency pull request may keep failing before it is worth interrupting you. */
    failingPrDays: 7,
    /** Days an open maintenance PR may wait before it is reported. */
    noRefreshDays: 15,
    /** Days a version must be published before the cooldown lets it in. */
    cooldownDays: 7,
    /** Days before an unresolved problem is raised again rather than staying silent. */
    escalateAfterDays: 7,
    /** Allow the weekly prune to run after an exclusion first matures. */
    exclusionGraceDays: 7,
  },
  /** Labels Renovate puts on security pull requests. Any match counts. */
  securityLabels: ["security"],
  /**
   * Which checks to run.
   *
   * Disabled checks appear explicitly in the diagnostic report.
   */
  checks: {
    securityPrs: true,
    failingPrs: true,
    lockfileRefresh: true,
    staleExclusions: true,
    defaultBranchBroken: true,
  },
};

function readJsonIfPresent(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error(`${file} is not valid JSON: ${(error as Error).message}`);
  }
}

/**
 * Non-secret settings: which repositories to watch, thresholds, commit identity.
 *
 * Repositories are listed rather than discovered from an account, so that a rename or a transfer
 * is noticed as a failing lookup instead of silently dropping out of coverage.
 */
export function loadSettings(): Settings {
  const file = settingsPath();
  const user = readJsonIfPresent(file) as Partial<Settings> | null;
  if (!user) {
    throw new Error(
      `No settings at ${file}. Copy config.example.json there and list your repositories.`,
    );
  }

  const settings = {
    ...DEFAULTS,
    ...user,
    thresholds: { ...DEFAULTS.thresholds, ...(user.thresholds ?? {}) },
    recovery: { ...DEFAULTS.recovery, ...(user.recovery ?? {}) },
    workspaceFiles: { ...DEFAULTS.workspaceFiles, ...(user.workspaceFiles ?? {}) },
    checks: { ...DEFAULTS.checks, ...(user.checks ?? {}) },
  };

  if (!Array.isArray(settings.repos) || settings.repos.length === 0) {
    throw new Error(`${file} lists no repositories under "repos".`);
  }
  const malformed = settings.repos.filter((r) => !/^[^/\s]+\/[^/\s]+$/.test(r));
  if (malformed.length) {
    throw new Error(
      `${file}: these are not "owner/name": ${malformed.join(", ")}`,
    );
  }
  if (typeof settings.recovery.enabled !== "boolean" || typeof settings.recovery.allowWatchdogMerge !== "boolean") {
    throw new Error("Recovery enabled and allowWatchdogMerge must be booleans");
  }
  if (settings.recovery.enabled) {
    const r = settings.recovery;
    if (!/^[^/\s]+\/[^/\s]+$/.test(r.watchdogRepo) || !path.isAbsolute(r.watchdogCheckout)
      || !path.isAbsolute(r.workspaceRoot) || !r.codexCommand
      || !Number.isInteger(r.maxAttempts) || r.maxAttempts < 1 || r.maxAttempts > 5
      || !Number.isFinite(r.timeoutMinutes) || r.timeoutMinutes < 1 || r.timeoutMinutes > 240) {
      throw new Error("Invalid recovery settings: provide a watchdog repo, absolute checkout and workspace paths, and bounded attempts and timeout");
    }
  }
  return settings;
}

/** Where a given repository keeps its pnpm settings. */
export function workspaceFileFor(settings: Settings, repo: string): string {
  return settings.workspaceFiles[repo] ?? settings.workspaceFile;
}

/**
 * Secrets, read from a shell-style file.
 *
 * Deliberately not dotenv: a handful of keys does not justify a dependency, and a watchdog with no
 * dependencies cannot be broken by a dependency update, which would be an unusually stupid way for
 * this to fail. Environment variables win over the file, so a container can inject them instead.
 */
export function loadSecrets({ required = true } = {}): Secrets {
  const secrets: Record<string, string> = {};
  let raw = "";
  try {
    raw = readFileSync(secretsPath(), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    secrets[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  for (const key of [
    "TELEGRAM_BOT_TOKEN",
    "TELEGRAM_CHAT_ID",
    "HEALTHCHECKS_PING_URL",
  ]) {
    const fromEnv = process.env[key];
    if (fromEnv) secrets[key] = fromEnv;
  }

  if (required) {
    const unset = ["TELEGRAM_BOT_TOKEN", "HEALTHCHECKS_PING_URL"].filter(
      (k) => !secrets[k] || secrets[k] === "PLACEHOLDER",
    );
    if (unset.length) {
      throw new Error(
        `Missing or placeholder in ${secretsPath()} (or the environment): ${unset.join(", ")}. ` +
          `Refusing to run half-configured, because a watchdog that cannot reach you is worse ` +
          `than no watchdog: its silence looks like good news.`,
      );
    }
  }
  return secrets;
}
