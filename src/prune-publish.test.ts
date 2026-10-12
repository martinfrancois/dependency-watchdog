import test from "node:test";
import assert from "node:assert/strict";
import { publishPrune, PrunePushRejected, type PruneChange, type PruneRunner } from "./prune.ts";
import { DEFAULTS } from "./config.ts";

const pnpm = (file = "pnpm-workspace.yaml"): PruneChange => ({ file, staged: [file], validation: "pnpm accepts it." });

test("pruning submits a PR after checking the staged file and never bypasses hooks", async () => {
  const calls: { command: string; args: string[] }[] = [];
  const run: PruneRunner = async (command, args) => {
    calls.push({ command, args });
    if (args.includes("list")) return "[]";
    if (args.includes("symbolic-ref")) return "origin/trunk";
    if (args.includes("--name-only")) return "pnpm-workspace.yaml";
    return "https://github.com/o/r/pull/1";
  };
  assert.equal(await publishPrune("o/r", "/unused", pnpm(), ["x@1"], DEFAULTS, run), "https://github.com/o/r/pull/1");
  assert.ok(calls.findIndex((c) => c.args.includes("--stat")) < calls.findIndex((c) => c.args[0] === "commit"));
  const push = calls.find((c) => c.args[0] === "push")!;
  assert.match(push.args.at(-1)!, /^watchdog\/prune-/);
  assert.ok(calls.find((c) => c.args.includes("create"))!.args.includes("trunk"));
  assert.ok(!calls.some((c) => c.args.includes("--no-verify") || c.args.includes("--force")));
  // One monitored repository runs commitlint with a 100 character body line limit.
  const body = calls.find((c) => c.args[0] === "commit")!.args.at(-1)!;
  assert.ok(body.split("\n").every((line) => line.length <= 72), body);
  assert.match(body, /^Removes 1 release-age exemption from pnpm-workspace\.yaml/);
  assert.ok(!body.includes("operator reviews"), "process notes belong in the PR, not the commit");
  assert.match(calls.find((c) => c.args.includes("create"))!.args.at(-1)!, /operator reviews this PR/);
});
test("an existing prune PR is reused without committing or pushing", async () => {
  let calls = 0;
  const url = await publishPrune("o/r", "/unused", pnpm("file"), [], DEFAULTS, async () => { calls++; return '[{"url":"existing"}]'; });
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
  await assert.rejects(publishPrune("o/r", "/unused", pnpm("file"), [], DEFAULTS, run("file\nother")), /unexpected staged/);
  await assert.rejects(publishPrune("o/r", "/unused", pnpm("file"), [], DEFAULTS, run("file")), PrunePushRejected);
});
test("a uv prune stages pyproject.toml and uv.lock together and says how it was checked", async () => {
  const calls: { command: string; args: string[] }[] = [];
  const run: PruneRunner = async (command, args) => {
    calls.push({ command, args });
    if (args.includes("list")) return "[]";
    if (args.includes("symbolic-ref")) return "origin/main";
    if (args.includes("--name-only")) return "uv.lock\npyproject.toml";
    return "https://github.com/o/r/pull/2";
  };
  const change: PruneChange = { file: "pyproject.toml", staged: ["pyproject.toml", "uv.lock"], validation: "uv lock --check accepts it." };
  await publishPrune("o/r", "/unused", change, ["ruff 2026-10-09T19:47:30Z"], DEFAULTS, run);
  assert.deepEqual(calls.find((c) => c.args[0] === "add")!.args, ["add", "pyproject.toml", "uv.lock"]);
  const body = calls.find((c) => c.args[0] === "commit")!.args.at(-1)!;
  assert.match(body, /^Removes 1 release-age exemption from pyproject\.toml/);
  assert.match(body, /- ruff 2026-10-09T19:47:30Z/);
  assert.match(body, /Validation: uv lock --check accepts it\./);
});
test("a uv prune refuses to commit when only one of its two files is staged", async () => {
  const run: PruneRunner = async (_command, args) => {
    if (args.includes("list")) return "[]";
    if (args.includes("--name-only")) return "pyproject.toml";
    if (args[0] === "commit") assert.fail("must not commit");
    return "origin/main";
  };
  const change: PruneChange = { file: "pyproject.toml", staged: ["pyproject.toml", "uv.lock"], validation: "" };
  await assert.rejects(publishPrune("o/r", "/unused", change, ["ruff x"], DEFAULTS, run), /unexpected staged/);
});
