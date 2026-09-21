import test, { describe } from "node:test";
import assert from "node:assert/strict";

import { decideNotifications, handleFailure, loadState, render, saveState, saveReport } from "./watchdog.ts";
import { ConfigDirUnset } from "./config.ts";
import type { Finding, State } from "./types.ts";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * The renderer is the whole point of the notification: a message you can act on without opening a
 * browser first, and paste into a coding agent as-is. These tests pin the parts that make it
 * actionable rather than its exact prose.
 */
describe("render", () => {
  const base: Finding = {
    id: "security-pr:o/r#7",
    kind: "security PR unmerged",
    repo: "o/r",
    url: "https://github.com/o/r/pull/7",
    number: 7,
    title: "fix(deps): update nanoid [SECURITY]",
    opened: "2026-08-01T00:00:00Z",
    ageText: "3d 5h",
    threshold: "48h",
  };

  test("leads with the problem and its age", async () => {
    const out = await render(base);
    assert.ok(out.startsWith("🔴 STUCK 3d 5h: security PR unmerged"));
  });

  test("includes everything needed to act", async () => {
    const out = await render(base);
    for (const fragment of [
      "o/r",
      "#7",
      "https://github.com/o/r/pull/7",
      "fix(deps): update nanoid [SECURITY]",
      "threshold 48h",
    ]) {
      assert.ok(out.includes(fragment), `missing: ${fragment}`);
    }
  });

  test("ends with commands that can be pasted straight into an agent", async () => {
    const out = await render(base);
    assert.ok(out.includes("gh pr view 7 --repo o/r"));
    assert.ok(out.includes("gh pr checks 7 --repo o/r"));
  });

  test("names the failing checks when there are any", async () => {
    const out = await render({
      ...base,
      failing: [{ name: "build", conclusion: "failure", url: "https://ci/1" }],
    });
    assert.ok(out.includes('check "build" conclusion=failure'));
    assert.ok(out.includes("https://ci/1"));
  });

  test("lists matured exclusion entries", async () => {
    const out = await render({
      id: "stale:o/r",
      kind: "cooldown exclusions not pruned",
      repo: "o/r",
      url: "https://github.com/o/r",
      file: "pnpm-workspace.yaml",
      entries: ["a@1.0.0", "b@2.0.0"],
    });
    assert.ok(out.includes("matured entries in pnpm-workspace.yaml"));
    assert.ok(out.includes("a@1.0.0"));
  });

  test("truncates a long entry list rather than flooding the message", async () => {
    // Telegram caps messages, and a wall of package names buries the actionable part.
    const entries = Array.from({ length: 20 }, (_, i) => `pkg${i}@1.0.0`);
    const out = await render({
      id: "stale:o/r",
      kind: "cooldown exclusions not pruned",
      repo: "o/r",
      url: "https://github.com/o/r",
      file: "pnpm-workspace.yaml",
      entries,
    });
    assert.ok(out.includes("… and 8 more"));
  });

  test("falls back to a plain link for findings without a pull request", async () => {
    const out = await render({
      id: "refresh-missing:o/r",
      kind: "no lockfile refresh",
      repo: "o/r",
      url: "https://github.com/o/r/pulls",
      last: "2026-07-01T00:00:00Z",
      threshold: "15d",
    });
    assert.ok(out.includes("link   https://github.com/o/r/pulls"));
    assert.ok(out.includes("last   2026-07-01T00:00:00Z"));
    assert.ok(!out.includes("gh pr checks"));
  });
});

describe("decideNotifications", () => {
  const DAY = 86_400_000;
  const f = (id: string): Finding => ({ id, kind: "stuck", repo: "o/r", url: "u" });
  const fresh = (): State => ({ seen: {} });

  test("says nothing the first time it sees a problem", () => {
    // One bad API response or a check mid-flight must not page anyone.
    const state = fresh();
    assert.deepEqual(decideNotifications([f("a")], state, 1000, 7), []);
    assert.deepEqual(state.seen["a"], { first: 1000, notified: null });
  });

  test("notifies on the second consecutive sighting", () => {
    const state: State = { seen: { a: { first: 1000, notified: null } } };
    const out = decideNotifications([f("a")], state, 2000, 7);
    assert.deepEqual(out.map((x) => x.id), ["a"]);
    assert.equal(state.seen["a"]!.notified, 2000);
  });

  test("does not repeat a problem it has already reported", () => {
    const state: State = { seen: { a: { first: 0, notified: 1000 } } };
    assert.deepEqual(decideNotifications([f("a")], state, 1000 + DAY, 7), []);
  });

  test("escalates once the window has passed, marking it as still open", () => {
    const state: State = { seen: { a: { first: 0, notified: 1000 } } };
    const out = decideNotifications([f("a")], state, 1000 + 8 * DAY, 7);
    assert.equal(out.length, 1);
    assert.equal(out[0]!.kind, "stuck (still open)");
    assert.equal(state.seen["a"]!.notified, 1000 + 8 * DAY);
  });

  test("forgets a problem once it is resolved", () => {
    // So the same thing recurring next month is reported afresh rather than staying silent.
    const state: State = { seen: { gone: { first: 0, notified: 1000 } } };
    decideNotifications([], state, 2000, 7);
    assert.deepEqual(Object.keys(state.seen), []);
  });

  test("tracks several problems independently", () => {
    const state: State = {
      seen: { a: { first: 0, notified: null }, b: { first: 0, notified: 500 } },
    };
    const out = decideNotifications([f("a"), f("b"), f("c")], state, 1000, 7);
    assert.deepEqual(out.map((x) => x.id), ["a"], "a is due, b is quiet, c is new");
    assert.ok(state.seen["c"], "c must be recorded for next time");
  });
});

describe("state persistence", () => {
  const dirs: string[] = [];
  const withStateDir = (): string => {
    const dir = mkdtempSync(path.join(tmpdir(), "wd-state-"));
    dirs.push(dir);
    process.env.XDG_STATE_HOME = dir;
    return dir;
  };

  test("round-trips what was saved", () => {
    withStateDir();
    const state: State = { seen: { a: { first: 1, notified: 2 } }, baselines: { "o/r": 3 } };
    saveState(state);
    assert.deepEqual(loadState(), state);
  });

  test("starts fresh when there is no file yet", () => {
    withStateDir();
    assert.deepEqual(loadState(), { seen: {} });
  });

  test("starts fresh rather than crashing on a corrupt file", () => {
    // Reporting open problems twice is noisy once. Refusing to run reports nothing, which is the
    // failure this project exists to prevent.
    const dir = withStateDir();
    const file = path.join(dir, "dep-watchdog", "state.json");
    saveState({ seen: {} });
    writeFileSync(file, "{ not json");
    assert.deepEqual(loadState(), { seen: {} });
  });

  test("creates the directory it needs", () => {
    withStateDir();
    assert.doesNotThrow(() => saveState({ seen: {} }));
  });

  process.on("exit", () => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });
});

describe("render for a broken default branch", () => {
  const finding: Finding = {
    id: "main-broken:o/r:dep1",
    kind: "default branch broken by a dependency update",
    repo: "o/r",
    url: "https://gh/dep1",
    title: "chore(deps): update dependency uuid to v14",
    sha: "dep1abcd",
    last: "2026-08-08T00:00:00Z",
    threshold: "2 commits failing since",
    brokenSince: [
      { sha: "dep1abcd", message: "chore(deps): update dependency uuid to v14", author: "renovate[bot]", date: "2026-08-08T00:00:00Z", url: "https://gh/dep1" },
      { sha: "feat9999", message: "feat: unrelated work on top", author: "martinfrancois", date: "2026-08-08T01:00:00Z", url: "https://gh/feat" },
    ],
    failing: [{ name: "test", conclusion: "failure", steps: 4 }],
  };

  test("does not leave a dangling age in the header", async () => {
    const out = await render(finding);
    assert.ok(!out.includes("STUCK :"), out.split("\n")[0]);
    assert.ok(out.startsWith("🔴 default branch broken"));
  });

  test("names the dependency commit that is being blamed", async () => {
    const out = await render(finding);
    assert.ok(out.includes("chore(deps): update dependency uuid to v14"));
    assert.ok(out.includes("dep1abcd"));
  });

  test("lists the failing run of commits so the scope is obvious", async () => {
    const out = await render(finding);
    assert.ok(out.includes("failing since (2 commits failing since)"));
    assert.ok(out.includes("feat: unrelated work on top"));
  });

  test("gives branch commands rather than pull request ones", async () => {
    // There is no pull request to open; gh pr view would be useless here.
    const out = await render(finding);
    assert.ok(out.includes("gh run list --repo o/r --commit dep1abcd"));
    assert.ok(!out.includes("gh pr checks"));
  });

  test("truncates a long failing run", async () => {
    const many = Array.from({ length: 15 }, (_, i) => ({
      sha: `sha${i}`, message: `commit ${i}`, author: "x", date: "d", url: "u",
    }));
    const out = await render({ ...finding, brokenSince: many });
    assert.ok(out.includes("… and 7 more"));
  });
});

describe("the reproduce block matches the finding", () => {
  /**
   * These messages exist to be pasted somewhere and run. A command that cannot work is worse than
   * no command: it costs the reader the time it takes to find out.
   */
  const exclusions: Finding = {
    id: "stale:o/r", kind: "cooldown exclusions not pruned", repo: "o/r",
    url: "https://github.com/o/r", file: "frontend/pnpm-workspace.yaml",
    entries: ["brace-expansion@2.1.4", "fast-uri@3.1.5"],
  };

  test("never emits a pull request command without a pull request number", async () => {
    // The real bug: "gh pr view  --repo o/r", with the empty number leaving a double space.
    for (const f of [exclusions, {
      id: "refresh:o/r", kind: "no lockfile refresh", repo: "o/r",
      url: "https://github.com/o/r/pulls", last: "2026-07-01T00:00:00Z", threshold: "15d",
    } as Finding]) {
      const out = await render(f);
      assert.ok(!out.includes("gh pr view  "), `double space in: ${out}`);
      assert.ok(!/gh pr view\s+--repo/.test(out), `numberless pr view in: ${out}`);
    }
  });

  test("points at the file and the prune for matured exclusions", async () => {
    const out = await render(exclusions);
    assert.ok(out.includes("contents/frontend/pnpm-workspace.yaml"));
    assert.ok(out.includes("cli-prune.ts --dry-run"));
  });

  test("still gives both pull request commands when there is one", async () => {
    const out = await render({
      id: "security-pr:o/r#7", kind: "security PR unmerged", repo: "o/r",
      url: "https://github.com/o/r/pull/7", number: 7, title: "fix", ageText: "3d", threshold: "48h",
    });
    assert.ok(out.includes("gh pr view 7 --repo o/r"));
    assert.ok(out.includes("gh pr checks 7 --repo o/r"));
  });

  test("falls back to opening the repository when there is nothing more specific", async () => {
    const out = await render({ id: "x", kind: "something", repo: "o/r", url: "u" });
    assert.ok(out.includes("gh repo view o/r --web"));
  });
});

test("JSON inspection and failed dry runs do not write state or contact notifiers", async () => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { mkdirSync, existsSync } = await import("node:fs");
  const dir = mkdtempSync("/var/tmp/watchdog-cli-test-");
  try {
    mkdirSync(path.join(dir, "config"));
    writeFileSync(path.join(dir, "config", "config.json"), JSON.stringify({ repos: ["o/r"], checks: { securityPrs: false, failingPrs: false, lockfileRefresh: false, staleExclusions: false, defaultBranchBroken: false } }));
    const env = { ...process.env, DEP_WATCHDOG_CONFIG_DIR: path.join(dir, "config"), XDG_STATE_HOME: path.join(dir, "state"), HEALTHCHECKS_PING_URL: "invalid-url" };
    const run = promisify(execFile);
    const fetchMarker = path.join(dir, "fetch-called");
    const preload = path.join(dir, "observe-fetch.mjs");
    writeFileSync(preload, `import { writeFileSync } from "node:fs"; globalThis.fetch = async () => { writeFileSync(${JSON.stringify(fetchMarker)}, "called"); throw new Error("unexpected notification"); };`);
    const result = await run(process.execPath, ["--import", preload, "src/cli-watchdog.ts", "--json"], { env });
    const report = JSON.parse(result.stdout);
    assert.equal(report.complete, true);
    assert.equal(report.checks.length, 5);
    assert.equal(report.sourceDigest.length, 64);
    assert.equal(existsSync(path.join(dir, "state")), false);
    writeFileSync(path.join(dir, "config", "config.json"), "{");
    await assert.rejects(run(process.execPath, ["--import", preload, "src/cli-watchdog.ts", "--dry-run"], { env }), (error: unknown) => {
      assert.match((error as { stderr: string }).stderr, /not valid JSON/);
      assert.doesNotMatch((error as { stderr: string }).stderr, /invalid-url|fetch/);
      return true;
    });
    assert.equal(existsSync(path.join(dir, "state")), false);
    assert.equal(existsSync(fetchMarker), false, "even a failed dry run must not attempt a notifier request");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writes parseable watchdog and prune reports and rejects malformed state shapes", async () => {
  const { readFileSync, existsSync } = await import("node:fs");
  const { inspect } = await import("./diagnostics.ts");
  const { DEFAULTS } = await import("./config.ts");
  const { savePruneReport } = await import("./prune.ts");
  const prior = process.env.XDG_STATE_HOME;
  const dir = mkdtempSync("/var/tmp/watchdog-report-test-");
  process.env.XDG_STATE_HOME = dir;
  try {
    const report = await inspect({ ...DEFAULTS, repos: [] }, { seen: {} });
    saveReport(report);
    const saved = JSON.parse(readFileSync(path.join(dir, "dep-watchdog", "last-run.json"), "utf8"));
    assert.equal(saved.runId, report.runId);
    assert.equal(existsSync(path.join(dir, "dep-watchdog", "last-run.json.tmp")), false);
    const prune = { startedAt: "2026-09-19T00:00:00Z", finishedAt: "2026-09-19T00:01:00Z", results: [{ repo: "o/r", error: "pnpm failed" }] };
    savePruneReport(prune);
    assert.deepEqual(JSON.parse(readFileSync(path.join(dir, "dep-watchdog", "last-prune.json"), "utf8")), prune);
    writeFileSync(path.join(dir, "dep-watchdog", "state.json"), '{"seen":[]}');
    assert.deepEqual(loadState(), { seen: {} });
  } finally {
    if (prior === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = prior;
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("handleFailure", () => {
  function capture(): { lines: string[]; restore: () => void } {
    const lines: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
    return { lines, restore: () => { console.error = original; } };
  }

  test("reports a missing configuration directory once and stops", async () => {
    delete process.env.DEP_WATCHDOG_CONFIG_DIR;
    const { lines, restore } = capture();
    try {
      await handleFailure(new ConfigDirUnset("DEP_WATCHDOG_CONFIG_DIR is not set."));
    } finally {
      restore();
    }
    assert.equal(process.exitCode, 1);
    process.exitCode = 0;
    assert.deepEqual(lines, ["DEP_WATCHDOG_CONFIG_DIR is not set."]);
  });

  test("negative control: any other failure still tries to reach the operator", async () => {
    delete process.env.DEP_WATCHDOG_CONFIG_DIR;
    const { restore } = capture();
    try {
      await assert.rejects(handleFailure(new Error("something else")), ConfigDirUnset);
    } finally {
      restore();
      process.exitCode = 0;
    }
  });
});
