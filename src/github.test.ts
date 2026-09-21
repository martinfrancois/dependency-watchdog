import test, { describe } from "node:test";
import assert from "node:assert/strict";

import {
  checkStatus,
  fileContents,
  gh,
  isBillingBlocked,
  hasLockfile,
  openPullRequests,
  recentCommits,
  strictChecksRequired,
  toCheckRuns,
} from "./github.ts";
import type { CheckRun } from "./types.ts";

/**
 * The distinction this function draws is the difference between a useful alert and a flood. When
 * an account cannot run CI, every check in every private repository reports as a failure that never
 * started. Treating those as real failures would fire for all of them at once, on the day you can
 * least do anything about it.
 */
describe("isBillingBlocked", () => {
  const run = (over: Partial<CheckRun>): CheckRun => ({
    name: "test",
    conclusion: "failure",
    steps: 0,
    started: "2026-08-08T12:00:00Z",
    completed: "2026-08-08T12:00:02Z",
    ...over,
  });

  test("a failure with no steps that ended in seconds never started", () => {
    assert.equal(isBillingBlocked(run({})), true);
  });

  test("a failure with steps is a real failure", () => {
    assert.equal(isBillingBlocked(run({ steps: 7 })), false);
  });

  test("a success is never treated as blocked", () => {
    assert.equal(isBillingBlocked(run({ conclusion: "success" })), false);
  });

  test("a long run with no steps is a real failure", () => {
    // Zero steps alone is not enough. A job can fail after running for minutes without the API
    // reporting steps, and silently ignoring those would hide genuine breakage.
    assert.equal(
      isBillingBlocked(
        run({ completed: "2026-08-08T12:05:00Z" }),
      ),
      false,
    );
  });

  test("missing timestamps do not establish a billing block", () => {
    // Missing timestamps do not establish that a job was blocked before it ran.
    assert.equal(
      isBillingBlocked({ name: "x", conclusion: "failure", steps: 0 }),
      false,
    );
  });

  test("exactly at the boundary is not blocked", () => {
    assert.equal(
      isBillingBlocked(run({ completed: "2026-08-08T12:00:30Z" })),
      false,
    );
  });
});

describe("toCheckRuns", () => {
  test("carries the step count through, since that is what marks a job that never started", () => {
    const out = toCheckRuns(
      [{ name: "test", conclusion: "failure", started_at: "a", completed_at: "b", steps: [1, 2], html_url: "u" }],
      [],
    );
    assert.equal(out.length, 1);
    assert.equal(out[0]!.steps, 2);
    assert.equal(out[0]!.url, "u");
  });

  test("keeps absent job step data unknown", () => {
    const out = toCheckRuns([{ name: "t", conclusion: "failure" }], []);
    assert.equal(out[0]!.steps, undefined);
    assert.equal(isBillingBlocked(out[0]!), false);
  });

  test("normalises legacy commit statuses alongside check runs", () => {
    const out = toCheckRuns(
      [{ name: "check", conclusion: "success" }],
      [{ context: "legacy", state: "failure", target_url: "t" }],
    );
    assert.deepEqual(out.map((r) => r.name), ["check", "legacy"]);
    assert.equal(out[1]!.conclusion, "failure");
  });

  test("maps a successful legacy status to success", () => {
    const out = toCheckRuns([], [{ context: "ci", state: "success" }]);
    assert.equal(out[0]!.conclusion, "success");
    assert.equal(out[0]!.url, undefined);
  });

  test("handles both sides being empty", () => {
    assert.deepEqual(toCheckRuns([], []), []);
  });
});

describe("gh", () => {
  const capture = (stdout: string) => {
    const calls: string[][] = [];
    const runner = async (_cmd: string, args: string[]) => {
      calls.push(args);
      return { stdout };
    };
    return { calls, runner };
  };

  test("asks the API and parses the reply", async () => {
    const { calls, runner } = capture('{"ok":true}');
    assert.deepEqual(await gh("repos/o/r", { runner }), { ok: true });
    assert.deepEqual(calls[0], ["api", "repos/o/r", "--cache", "0"]);
  });

  test("flattens paginated pages into one list", async () => {
    // --slurp wraps each page in its own array; callers want a single list.
    const { calls, runner } = capture("[[{\"n\":1}],[{\"n\":2}]]");
    assert.deepEqual(await gh("x", { paginate: true, runner }), [{ n: 1 }, { n: 2 }]);
    assert.ok(calls[0]!.includes("--slurp"));
  });

  test("does not cache, so a run sees current state", async () => {
    const { calls, runner } = capture("{}");
    await gh("x", { runner });
    assert.deepEqual(calls[0]!.slice(-2), ["--cache", "0"]);
  });
});

describe("fileContents", () => {
  const runnerFor = (stdout: string) => async () => ({ stdout });

  test("decodes base64 content", async () => {
    const body = JSON.stringify({ content: Buffer.from("hello: world\n").toString("base64") });
    assert.equal(await fileContents("o/r", "f.yaml", "HEAD", runnerFor(body)), "hello: world\n");
  });

  test("returns null for a file that does not exist", async () => {
    // A missing workspace file is normal, not an error: it means that repository has no gate.
    const failing = async () => { throw new Error("404"); };
    assert.equal(await fileContents("o/r", "missing.yaml", "HEAD", failing), null);
  });
});

describe("openPullRequests and checkStatus", () => {
  test("openPullRequests paginates", async () => {
    const calls: string[][] = [];
    const runner = async (_c: string, args: string[]) => { calls.push(args); return { stdout: "[[]]" }; };
    assert.deepEqual(await openPullRequests("o/r", runner), []);
    assert.ok(calls[0]!.includes("--paginate"));
  });

  test("checkStatus merges both endpoints", async () => {
    const runner = async (_c: string, args: string[]) => ({
      stdout: args[1]!.includes("check-runs")
        ? JSON.stringify({ check_runs: [{ name: "a", conclusion: "success", steps: [1] }] })
        : JSON.stringify({ statuses: [{ context: "b", state: "failure" }] }),
    });
    const out = await checkStatus("o/r", "sha", runner);
    assert.deepEqual(out.map((r) => r.name), ["a", "b"]);
  });

  test("checkStatus rejects incomplete coverage", async () => {
    const runner = async (_c: string, args: string[]) => {
      if (args[1]!.includes("check-runs")) throw new Error("boom");
      return { stdout: JSON.stringify({ statuses: [{ context: "b", state: "success" }] }) };
    };
    await assert.rejects(checkStatus("o/r", "sha", runner), /boom/);
  });
});

describe("recentCommits", () => {
  const raw = [
    {
      sha: "abc123",
      html_url: "https://gh/abc123",
      commit: { message: "chore(deps): update uuid\n\nbody text", committer: { date: "2026-08-01T00:00:00Z" } },
      author: { login: "renovate[bot]" },
    },
  ];

  test("keeps only the subject line and the author login", async () => {
    const out = await recentCommits("o/r", "main", 20, async () => ({ stdout: JSON.stringify(raw) }));
    assert.equal(out.length, 1);
    assert.equal(out[0]!.message, "chore(deps): update uuid", "the body would bury the subject in a message");
    assert.equal(out[0]!.author, "renovate[bot]");
    assert.equal(out[0]!.sha, "abc123");
  });

  test("survives a commit with no author and no committer date", async () => {
    const bare = [{ sha: "d", html_url: "u", commit: { message: "x" } }];
    const out = await recentCommits("o/r", "main", 5, async () => ({ stdout: JSON.stringify(bare) }));
    assert.equal(out[0]!.author, null);
    assert.equal(out[0]!.date, "");
  });

  test("asks for the requested branch and page size", async () => {
    const calls: string[][] = [];
    await recentCommits("o/r", "release/1.x", 7, async (_c, args) => { calls.push(args); return { stdout: "[]" }; });
    assert.ok(calls[0]![1]!.includes("sha=release%2F1.x"), calls[0]![1]);
    assert.ok(calls[0]![1]!.includes("per_page=7"));
  });
});

describe("strictChecksRequired", () => {
  const runner = (byPath: Record<string, unknown>) => async (_c: string, args: string[]) => {
    const path = args[1]!;
    const key = Object.keys(byPath).find((k) => path.includes(k));
    if (!key) throw new Error(`unexpected ${path}`);
    return { stdout: JSON.stringify(byPath[key]) };
  };

  test("true when a ruleset requires branches to be up to date", async () => {
    const out = await strictChecksRequired("o/r", runner({
      "rulesets/1": { rules: [{ type: "required_status_checks", parameters: { strict_required_status_checks_policy: true } }] },
      "rulesets": [{ id: 1 }],
    }));
    assert.equal(out, true);
  });

  test("false when the policy is off", async () => {
    const out = await strictChecksRequired("o/r", runner({
      "rulesets/1": { rules: [{ type: "required_status_checks", parameters: { strict_required_status_checks_policy: false } }] },
      "rulesets": [{ id: 1 }],
    }));
    assert.equal(out, false);
  });

  test("false when there is no ruleset at all", async () => {
    const out = await strictChecksRequired("o/r", runner({ "rulesets": [] }));
    assert.equal(out, false);
  });

  test("false when a ruleset has no status-check rule", async () => {
    const out = await strictChecksRequired("o/r", runner({
      "rulesets/1": { rules: [{ type: "deletion" }] },
      "rulesets": [{ id: 1 }],
    }));
    assert.equal(out, false);
  });

  test("false when the lookup fails", async () => {
    // Deliberate direction: an error means "watch this repository". Failing the other way would
    // silently drop a repository out of coverage, which looks identical to nothing being wrong.
    const out = await strictChecksRequired("o/r", async () => { throw new Error("403"); });
    assert.equal(out, false);
  });
});

describe("hasLockfile", () => {
  const tree = (paths: string[]) => async () => ({ stdout: JSON.stringify({ tree: paths.map((p) => ({ path: p })) }) });

  test("finds a lockfile at the root", async () => {
    assert.equal(await hasLockfile("o/r", tree(["package.json", "pnpm-lock.yaml"])), true);
  });

  test("finds one nested in a subdirectory", async () => {
    // Some repositories keep their lockfile in a subdirectory such as frontend/ or tools/.
    assert.equal(await hasLockfile("o/r", tree(["frontend/pnpm-lock.yaml"])), true);
  });

  test("false for a repository that commits none", async () => {
    assert.equal(await hasLockfile("o/r", tree(["pom.xml", "src/Main.java"])), false);
  });

  test("does not mistake a similarly named file for a lockfile", async () => {
    assert.equal(await hasLockfile("o/r", tree(["docs/package-lock.json.md", "notes/yarn.lock.txt"])), false);
  });

  test("rejects a failed tree lookup", async () => {
    await assert.rejects(hasLockfile("o/r", async () => { throw new Error("500"); }), /500/);
  });
});

test("a short Actions failure with executed steps remains a failure", async () => {
  const runner = async (_cmd: string, args: string[]) => ({ stdout: JSON.stringify(
    args[1]!.includes("check-runs") ? [{ check_runs: [{ name: "lint", conclusion: "failure", started_at: "2026-01-01T00:00:00Z", completed_at: "2026-01-01T00:00:04Z", html_url: "https://github.com/o/r/actions/runs/1/job/2" }] }]
      : args[1]!.includes("actions/jobs") ? { steps: [{ conclusion: "success" }, { conclusion: "failure" }] }
        : [{ statuses: [] }],
  ) });
  const runs = await checkStatus("o/r", "abc", runner);
  assert.equal(runs[0]!.steps, 2);
  assert.equal(isBillingBlocked(runs[0]!), false);
});

test("collects check runs across pages and ignores older legacy statuses", async () => {
  const runner = async (_cmd: string, args: string[]) => ({ stdout: JSON.stringify(
    args[1]!.includes("check-runs") ? [{ check_runs: [{ name: "a", conclusion: "success" }] }, { check_runs: [{ name: "b", conclusion: "failure" }] }]
      : [{ statuses: [{ context: "legacy", state: "success" }] }, { statuses: [{ context: "legacy", state: "failure" }] }],
  ) });
  const runs = await checkStatus("o/r", "abc", runner);
  assert.deepEqual(runs.map((r) => [r.name, r.conclusion]), [["a", "success"], ["b", "failure"], ["legacy", "success"]]);
});

test("workspace permission failures and truncated trees remain visible", async () => {
  await assert.rejects(fileContents("o/r", "f.yaml", "HEAD", async () => { throw new Error("HTTP 403"); }), /403/);
  await assert.rejects(hasLockfile("o/r", async () => ({ stdout: '{"tree":[],"truncated":true}' })), /Incomplete/);
});
