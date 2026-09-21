import test from "node:test";
import assert from "node:assert/strict";
import { publishPrune, PrunePushRejected, type PruneRunner } from "./prune.ts";
import { DEFAULTS } from "./config.ts";

test("pruning submits a PR after checking the staged file and never bypasses hooks", async () => {
  const calls: { command: string; args: string[] }[] = [];
  const run: PruneRunner = async (command, args) => {
    calls.push({ command, args });
    if (args.includes("list")) return "[]";
    if (args.includes("symbolic-ref")) return "origin/trunk";
    if (args.includes("--name-only")) return "pnpm-workspace.yaml";
    return "https://github.com/o/r/pull/1";
  };
  assert.equal(await publishPrune("o/r", "/unused", "pnpm-workspace.yaml", ["x@1"], DEFAULTS, run), "https://github.com/o/r/pull/1");
  assert.ok(calls.findIndex((c) => c.args.includes("--stat")) < calls.findIndex((c) => c.args[0] === "commit"));
  const push = calls.find((c) => c.args[0] === "push")!;
  assert.match(push.args.at(-1)!, /^watchdog\/prune-/);
  assert.ok(calls.find((c) => c.args.includes("create"))!.args.includes("trunk"));
  assert.ok(!calls.some((c) => c.args.includes("--no-verify") || c.args.includes("--force")));
});
test("an existing prune PR is reused without committing or pushing", async () => {
  let calls = 0;
  const url = await publishPrune("o/r", "/unused", "file", [], DEFAULTS, async () => { calls++; return '[{"url":"existing"}]'; });
  assert.equal(url, "existing"); assert.equal(calls, 1);
});
test("unexpected staged files and rejected pushes stop publication", async () => {
  const run = (staged: string): PruneRunner => async (_command, args) => {
    if (args.includes("list")) return "[]";
    if (args.includes("--name-only")) return staged;
    if (args[0] === "push") throw new Error("pre-push rejected");
    if (args.includes("create")) assert.fail("must not create after rejected push");
    return "origin/main";
  };
  await assert.rejects(publishPrune("o/r", "/unused", "file", [], DEFAULTS, run("file\nother")), /unexpected staged/);
  await assert.rejects(publishPrune("o/r", "/unused", "file", [], DEFAULTS, run("file")), PrunePushRejected);
});
