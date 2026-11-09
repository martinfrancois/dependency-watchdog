import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DEFAULTS } from "./config.ts";
import {
  findStaleReferences, pnpmSearchTerms, uvSearchTerms, publishPrune, REFERENCE_LIMIT, REFERENCE_WIDTH, removeEntries, type PruneChange, type PruneRunner,
} from "./prune.ts";

const WORKSPACE = `# Matured versions are pruned; see minimumReleaseAgeExclude below.
minimumReleaseAge: 10080

# Security fix, removable once it is seven days old.
minimumReleaseAgeExclude:
  # example-pkg@1.2.3 fixes an advisory.
  - example-pkg@1.2.3
`;

function repoWith(files: Record<string, string>): string {
  const dir = mkdtempSync("/var/tmp/watchdog-references-test-");
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), text);
  }
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.test", "commit", "-q", "-m", "init"], { cwd: dir });
  return dir;
}

test("a pnpm prune searches for the removed key only when removeEntries dropped it", () => {
  const both = `minimumReleaseAgeExclude:\n  - example-pkg@1.2.3\n  - other-pkg@2.0.0\n`;
  assert.deepEqual(pnpmSearchTerms(["example-pkg@1.2.3"], removeEntries(both, ["example-pkg@1.2.3"])), ["example-pkg@1.2.3"]);
  assert.deepEqual(pnpmSearchTerms(["example-pkg@1.2.3"], removeEntries(WORKSPACE, ["example-pkg@1.2.3"])), ["example-pkg@1.2.3", "minimumReleaseAgeExclude"]);
});

test("leftover mentions are found outside the removed block and lockfiles, as whole words", async () => {
  const dir = repoWith({
    "pnpm-workspace.yaml": WORKSPACE,
    "pnpm-lock.yaml": "example-pkg@1.2.3:\n",
    "packages/a/pnpm-lock.yaml": "example-pkg@1.2.3:\n",
    "bun.lock": "example-pkg@1.2.3\n",
    "docs/adr/0001-exclusions.md": "The exclusion list carries example-pkg@1.2.3.\n",
    "docs/kept.md": "example-pkg@1.2.30 and other-example-pkg@1.2.3 stay.\n",
    "pyproject.toml": "# Typing_Extensions is held back.\n# sixty packages\n# zope.interface stays pinned.\n",
    "six/mod.py": "sixty = 1\n",
  });
  try {
    // The prune writes the edited file before it publishes, as prunePnpm does.
    writeFileSync(path.join(dir, "pnpm-workspace.yaml"), removeEntries(WORKSPACE, ["example-pkg@1.2.3"]));
    const hits = await findStaleReferences(dir, ["example-pkg@1.2.3", "minimumReleaseAgeExclude"]);
    assert.deepEqual(hits.sort(), [
      "docs/adr/0001-exclusions.md:1:The exclusion list carries example-pkg@1.2.3.",
      "pnpm-workspace.yaml:1:# Matured versions are pruned; see minimumReleaseAgeExclude below.",
    ]);
    // six/mod.py matches only through its path, which must not count.
    assert.deepEqual(await findStaleReferences(dir, uvSearchTerms(["typing-extensions", "six", "zope-interface"])), [
      "pyproject.toml:1:# Typing_Extensions is held back.",
      "pyproject.toml:3:# zope.interface stays pinned.",
    ]);
    assert.deepEqual(await findStaleReferences(dir, ["other-pkg@9.9.9"]), [], "git grep finding nothing is not an error");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

type Call = { command: string; args: string[] };
function fakeGit(grep: (args: string[]) => Promise<string>): { calls: Call[]; run: PruneRunner } {
  const calls: Call[] = [];
  const run: PruneRunner = async (command, args) => {
    calls.push({ command, args });
    if (args.includes("grep")) return grep(args);
    if (args.includes("list")) return "[]";
    if (args.includes("symbolic-ref")) return "origin/main";
    if (args.includes("--name-only")) return "pnpm-workspace.yaml";
    return "https://github.com/o/r/pull/3";
  };
  return { calls, run };
}
const change = (searchFor: string[]): PruneChange => ({ file: "pnpm-workspace.yaml", staged: ["pnpm-workspace.yaml"], validation: "ok", searchFor });
const prBody = (calls: Call[]): string => calls.find((c) => c.args.includes("create"))!.args.at(-1)!;

test("the PR body lists the hits in a code block, shortened and capped, and the commit body does not", async () => {
  const hits = Array.from({ length: REFERENCE_LIMIT + 2 }, (_, i) => `docs/a-${i}.md:${i + 1}: example-pkg@1.2.3`);
  hits[0] = "docs/notes.md:3: ask @someone about #12 and ```example-pkg@1.2.3```";
  hits[1] = `dist/app.min.js:1:${"x".repeat(5000)} example-pkg@1.2.3`;
  // git grep -z puts NUL after the path and after the line number.
  const { calls, run } = fakeGit(async () => hits.map((hit) => hit.replace(":", "\0").replace(":", "\0")).join("\n"));
  await publishPrune("o/r", "/unused", change(["example-pkg@1.2.3", "minimumReleaseAgeExclude"]), ["example-pkg@1.2.3"], DEFAULTS, run);
  const grep = calls.find((c) => c.args.includes("grep"))!.args;
  assert.deepEqual(grep.filter((_, i) => grep[i - 1] === "-e"), ["example-pkg@1.2.3", "minimumReleaseAgeExclude"]);
  assert.ok(grep.includes(":(exclude,glob)**/pnpm-lock.yaml"));
  const body = prBody(calls);
  assert.match(body, /References to check/);
  assert.ok(body.includes("\n````\ndocs/notes.md:3: ask @someone about #12 and ```example-pkg@1.2.3```\n"), "a fence longer than any backtick run in the hits");
  assert.ok(body.includes(`dist/app.min.js:1:${"x".repeat(REFERENCE_WIDTH - "dist/app.min.js:1:".length)}...\n`));
  assert.ok(body.includes(hits[REFERENCE_LIMIT - 1]!) && !body.includes(hits[REFERENCE_LIMIT]!));
  assert.match(body, /\n````\n\n2 more not shown\./);
  assert.ok(body.length < 65_536, "GitHub rejects a PR body over 65,536 characters");
  assert.ok(!calls.find((c) => c.args[0] === "commit")!.args.at(-1)!.includes("References to check"));
});

test("a failed search is reported in the PR instead of stopping the prune", async () => {
  const { calls, run } = fakeGit(async () => { throw Object.assign(new Error("stdout maxBuffer length exceeded"), { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" }); });
  assert.equal(await publishPrune("o/r", "/unused", change(["example-pkg@1.2.3"]), ["example-pkg@1.2.3"], DEFAULTS, run), "https://github.com/o/r/pull/3");
  assert.match(prBody(calls), /search for leftover references to the removed exemptions failed:\n\n```\nstdout maxBuffer length exceeded\n```/);
});

test("no hits means no section, and a uv prune searches its package names", async () => {
  const { calls, run } = fakeGit(async () => { throw Object.assign(new Error("exit 1"), { code: 1 }); });
  const uv: PruneChange = { file: "pyproject.toml", staged: ["pyproject.toml"], validation: "ok", searchFor: ["ruff"] };
  await publishPrune("o/r", "/unused", uv, ["ruff 2026-10-09T19:47:30Z"], DEFAULTS, async (command, args, cwd) => (args.includes("--name-only") ? "pyproject.toml" : run(command, args, cwd)));
  const grep = calls.find((c) => c.args.includes("grep"))!.args;
  assert.deepEqual(grep.filter((_, i) => grep[i - 1] === "-e"), ["ruff"]);
  assert.ok(!prBody(calls).includes("References to check"));
});
