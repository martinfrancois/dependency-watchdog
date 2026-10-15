import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { validatePnpm } from "./prune.ts";

test("pnpm validation overrides the configured store and removes its temporary store", async () => {
  let store = "";
  await validatePnpm("/unused", async (command, args, options) => {
    assert.equal(command, "pnpm");
    assert.deepEqual(args.slice(0, 4), ["install", "--lockfile-only", "--ignore-scripts", "--store-dir"]);
    assert.deepEqual(args.slice(5), ["--ignore-pnpmfile"]);
    store = args[4]!;
    assert.ok(path.isAbsolute(store));
    assert.ok(existsSync(store));
    assert.equal(options.cwd, "/unused");
    assert.equal(options.env.CI, "1");
    writeFileSync(path.join(store, "index.db"), "fixture");
  });
  assert.ok(!existsSync(store));
});

test("failed pnpm validation removes its store and retains stdout diagnostics", async () => {
  let store = "";
  await assert.rejects(validatePnpm("/unused", async (_command, args) => {
    store = args[4]!;
    writeFileSync(path.join(store, "index.db"), "fixture");
    throw { stdout: "unable to open database file", stderr: "", message: "command failed" };
  }), /unable to open database file/);
  assert.ok(!existsSync(store));
});

test("pnpm validation retains stderr or the execution error when stdout is absent", async () => {
  for (const error of [{ stderr: "invalid yaml" }, new Error("pnpm not found"), {}]) {
    await assert.rejects(validatePnpm("/unused", async () => { throw error; }),
      /invalid yaml|pnpm not found|unknown error/);
  }
});

test("pnpm validation never executes repository pnpmfile hooks", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "prune-hook-test-"));
  const marker = path.join(dir, "hook-executed");
  try {
    writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "fixture", private: true }));
    writeFileSync(path.join(dir, "pnpm-workspace.yaml"), "packages:\n  - .\n");
    writeFileSync(path.join(dir, ".pnpmfile.cjs"),
      `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed'); module.exports = {};\n`);
    await validatePnpm(dir);
    assert.ok(!existsSync(marker), "pnpm loaded the repository's executable configuration");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
