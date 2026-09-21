import test, { afterEach, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import * as cfg from "./config.ts";

// Each test supplies a private config directory; config resolves its paths when called.
const dirs: string[] = [];

function loadWith(files: Record<string, string>): typeof cfg {
  const dir = mkdtempSync(path.join(tmpdir(), "wd-cfg-"));
  dirs.push(dir);
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(path.join(dir, name), body);
  }
  process.env.DEP_WATCHDOG_CONFIG_DIR = dir;
  return cfg;
}

afterEach(() => {
  delete process.env.DEP_WATCHDOG_CONFIG_DIR;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("loadSettings", () => {
  test("applies defaults around the repositories you list", () => {
    const m = loadWith({
      "config.json": JSON.stringify({ repos: ["o/r"] }),
    });
    const s = m.loadSettings();
    assert.deepEqual(s.repos, ["o/r"]);
    assert.equal(s.workspaceFile, "pnpm-workspace.yaml");
    assert.equal(s.thresholds.securityPrHours, 48);
    assert.equal(s.checks.lockfileRefresh, true);
  });

  test("merges thresholds rather than replacing the whole object", async () => {
    // A user overriding one threshold must not silently lose the others.
    const m = loadWith({
      "config.json": JSON.stringify({
        repos: ["o/r"],
        thresholds: { securityPrHours: 6 },
      }),
    });
    const s = m.loadSettings();
    assert.equal(s.thresholds.securityPrHours, 6);
    assert.equal(s.thresholds.failingPrDays, 7, "untouched default must survive");
  });

  test("merges checks so one can be disabled without listing the rest", () => {
    const m = loadWith({
      "config.json": JSON.stringify({
        repos: ["o/r"],
        checks: { lockfileRefresh: false },
      }),
    });
    const s = m.loadSettings();
    assert.equal(s.checks.lockfileRefresh, false);
    assert.equal(s.checks.securityPrs, true);
  });

  test("explains itself when there is no settings file", () => {
    const m = loadWith({});
    assert.throws(() => m.loadSettings(), /Copy config.example.json/);
  });

  test("rejects an empty repository list", () => {
    const m = loadWith({ "config.json": JSON.stringify({ repos: [] }) });
    assert.throws(() => m.loadSettings(), /lists no repositories/);
  });

  test("rejects names that are not owner\\/name", () => {
    const m = loadWith({
      "config.json": JSON.stringify({ repos: ["o/r", "bare"] }),
    });
    assert.throws(() => m.loadSettings(), /not "owner\/name": bare/);
  });

  test("reports the position of malformed JSON", () => {
    const m = loadWith({ "config.json": '{"repos":[' });
    assert.throws(() => m.loadSettings(), /is not valid JSON/);
  });
});

describe("workspaceFileFor", () => {
  test("prefers a per-repo override, falling back to the default", () => {
    const m = loadWith({
      "config.json": JSON.stringify({
        repos: ["o/mono", "o/plain"],
        workspaceFiles: { "o/mono": "frontend/pnpm-workspace.yaml" },
      }),
    });
    const s = m.loadSettings();
    assert.equal(m.workspaceFileFor(s, "o/mono"), "frontend/pnpm-workspace.yaml");
    assert.equal(m.workspaceFileFor(s, "o/plain"), "pnpm-workspace.yaml");
  });
});

describe("loadSecrets", () => {
  test("reads keys and ignores comments and blank lines", () => {
    const m = loadWith({
      "config.env": "# a comment\n\nTELEGRAM_BOT_TOKEN=abc\nHEALTHCHECKS_PING_URL=https://x\n",
    });
    const s = m.loadSecrets();
    assert.equal(s.TELEGRAM_BOT_TOKEN, "abc");
  });

  test("refuses to run half-configured", async () => {
    // A watchdog that cannot reach you is worse than none: its silence reads as good news.
    const m = loadWith({
      "config.env": "TELEGRAM_BOT_TOKEN=PLACEHOLDER\nHEALTHCHECKS_PING_URL=PLACEHOLDER\n",
    });
    assert.throws(() => m.loadSecrets(), /Refusing to run half-configured/);
  });

  test("tolerates placeholders when they are not required", () => {
    const m = loadWith({
      "config.env": "TELEGRAM_BOT_TOKEN=PLACEHOLDER\n",
    });
    assert.doesNotThrow(() => m.loadSecrets({ required: false }));
  });

  test("lets the environment override the file", () => {
    const m = loadWith({
      "config.env": "TELEGRAM_BOT_TOKEN=from-file\nHEALTHCHECKS_PING_URL=https://x\n",
    });
    process.env.TELEGRAM_BOT_TOKEN = "from-env";
    try {
      assert.equal(m.loadSecrets().TELEGRAM_BOT_TOKEN, "from-env");
    } finally {
      delete process.env.TELEGRAM_BOT_TOKEN;
    }
  });

  test("treats a missing file as empty rather than throwing", () => {
    const m = loadWith({});
    assert.deepEqual(m.loadSecrets({ required: false }), {});
  });
});


test("recovery requires explicit boolean permission and bounded worker settings", () => {
  const recovery = { ...cfg.DEFAULTS.recovery, enabled: true, watchdogRepo: "o/watchdog", watchdogCheckout: "/opt/watchdog" };
  for (const change of [{ enabled: "false" }, { allowWatchdogMerge: "false" }, { maxAttempts: 0 }, { timeoutMinutes: 241 }, { watchdogCheckout: "relative" }]) {
    const m = loadWith({ "config.json": JSON.stringify({ repos: ["o/r"], recovery: { ...recovery, ...change } }) });
    assert.throws(() => m.loadSettings(), /Recovery|Invalid recovery/);
  }
  const m = loadWith({ "config.json": JSON.stringify({ repos: ["o/r"], recovery }) });
  assert.equal(m.loadSettings().recovery.allowWatchdogMerge, false);
});
