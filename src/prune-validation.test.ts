import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { validatePnpm } from "./prune.ts";

test("pnpm validation overrides the configured store and removes its temporary store", async () => {
  let store = "";
  await validatePnpm("/unused", async (command, args, options) => {
    assert.equal(command, "pnpm");
    assert.deepEqual(args.slice(0, 4), ["install", "--lockfile-only", "--ignore-scripts", "--store-dir"]);
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
