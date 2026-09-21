/** Shared shapes. Kept in one place so a change to a finding is a compile error everywhere. */

export type Thresholds = {
  securityPrHours: number;
  failingPrDays: number;
  noRefreshDays: number;
  cooldownDays: number;
  escalateAfterDays: number;
  exclusionGraceDays: number;
};

export type Checks = {
  securityPrs: boolean;
  failingPrs: boolean;
  lockfileRefresh: boolean;
  staleExclusions: boolean;
  defaultBranchBroken: boolean;
};

export type RecoverySettings = {
  enabled: boolean;
  codexCommand: string;
  watchdogRepo: string;
  watchdogCheckout: string;
  workspaceRoot: string;
  timeoutMinutes: number;
  maxAttempts: number;
  allowWatchdogMerge: boolean;
};

export type Settings = {
  repos: string[];
  recovery: RecoverySettings;
  workspaceFile: string;
  workspaceFiles: Record<string, string>;
  commitName: string | null;
  commitEmail: string | null;
  defaultBranch: string;
  thresholds: Thresholds;
  securityLabels: string[];
  checks: Checks;
};

export type Secrets = {
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
  HEALTHCHECKS_PING_URL?: string;
};

/** A single check result, in the shape the renderer expects. */
export type Finding = {
  /** Stable across runs, so a problem is reported once rather than daily. */
  id: string;
  kind: string;
  repo: string;
  url: string;
  number?: number;
  title?: string;
  opened?: string;
  last?: string;
  ageText?: string;
  threshold?: string;
  sha?: string;
  file?: string;
  entries?: string[];
  failing?: CheckRun[];
  /** Commits from the culprit up to the branch head, oldest first, when the branch is broken. */
  brokenSince?: Commit[];
};

export type Commit = {
  sha: string;
  message: string;
  /** The GitHub login, which is how a Renovate commit is told apart from a person's. */
  author: string | null;
  date: string;
  url: string;
};

export type CheckRun = {
  name: string;
  conclusion: string | null;
  started?: string | undefined;
  completed?: string | undefined;
  /** Job API step count. Absent means unknown, never zero by inference. */
  steps?: number;
  url?: string | undefined;
};

export type PullRequest = {
  number: number;
  title: string;
  html_url: string;
  created_at: string;
  labels?: { name: string }[];
  user?: { login: string } | null;
  head: { ref: string; sha: string };
};

export type State = {
  seen: Record<string, { first: number; notified: number | null }>;
  baselines?: Record<string, number>;
};
