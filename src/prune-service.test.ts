import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { homedir } from "node:os";

const unit = readFileSync(new URL("../systemd/dep-prune.service", import.meta.url), "utf8");

test("the prune service keeps pnpm's shared runtime locks writable and persistent", () => {
  assert.match(unit, /^RuntimeDirectory=pnpm-store-operation-locks-%U$/m);
  assert.match(unit, /^RuntimeDirectoryMode=0700$/m);
  assert.match(unit, /^RuntimeDirectoryPreserve=yes$/m);
  assert.match(unit, /^ProtectSystem=strict$/m);
  assert.match(unit, /^ProtectHome=read-only$/m);
});

test("pnpm validates a workspace inside the prune service's filesystem sandbox", (t) => {
  const systemManager = process.env.DEP_WATCHDOG_TEST_SYSTEMD_SYSTEM === "1";
  if (process.platform !== "linux" || !process.env.XDG_RUNTIME_DIR ||
      (!systemManager && spawnSync("systemctl", ["--user", "show-environment"], { stdio: "ignore" }).status !== 0)) {
    t.skip("requires a running systemd user manager");
    return;
  }
  // The empty fixture uses a private store, so it needs none of the installation's home paths.
  const properties = unit.split("\n").filter((line) =>
    /^(PrivateTmp|ProtectSystem|ProtectHome|RuntimeDirectory|RuntimeDirectoryMode|RuntimeDirectoryPreserve|NoNewPrivileges|RestrictSUIDSGID)=/.test(line));
  // systemd-run passes property values literally; unit files expand these specifiers.
  const uid = String(process.getuid!());
  const expand = (value: string) => value.replaceAll("%h", homedir())
    .replaceAll("%U", uid).replaceAll("%t", process.env.XDG_RUNTIME_DIR!)
    .replace(/^RuntimeDirectory=/, systemManager ? `RuntimeDirectory=user/${uid}/` : "RuntimeDirectory=");
  const script = `
    const { mkdtempSync, writeFileSync, rmSync } = require('node:fs');
    const { execFileSync } = require('node:child_process');
    const assert = require('node:assert/strict');
    const dir = mkdtempSync('/tmp/prune-service-test-');
    const probe = process.env.XDG_RUNTIME_DIR + '/prune-service-test-' + process.pid;
    try {
      assert.throws(() => writeFileSync(probe, ''), { code: 'EROFS' });
      writeFileSync(dir + '/package.json', JSON.stringify({ name: 'fixture', private: true }));
      writeFileSync(dir + '/pnpm-workspace.yaml', 'packages:\\n  - .\\n');
      execFileSync('pnpm', ['install', '--lockfile-only', '--ignore-scripts', '--ignore-pnpmfile', '--offline',
        '--store-dir', dir + '/store'], { cwd: dir, stdio: 'inherit' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
      try { rmSync(probe, { force: true }); } catch {}
    }
  `;
  // CI's user manager does not enforce these mounts. The system manager can set them up
  // before dropping to the same unprivileged user, without relaxing the assertions.
  const command = systemManager ? "sudo" : "systemd-run";
  const scope = systemManager ? ["-n", "systemd-run", `--property=User=${uid}`] : ["--user"];
  const output = execFileSync(command, [...scope, "--wait", "--pipe", "--collect",
    ...properties.flatMap((property) => ["--property", expand(property)]),
    "--setenv=CI=1", "--setenv=COREPACK_ENABLE_AUTO_PIN=0", `--setenv=PATH=${process.env.PATH}`,
    `--setenv=XDG_RUNTIME_DIR=${process.env.XDG_RUNTIME_DIR}`, `--setenv=HOME=${homedir()}`,
    process.execPath, "-e", script], { encoding: "utf8", timeout: 60_000 });
  assert.match(output, /Done in/);
});
