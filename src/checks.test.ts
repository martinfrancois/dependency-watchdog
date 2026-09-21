import test, { afterEach, describe } from "node:test";
import assert from "node:assert/strict";

import {
  automergePrsFailing,
  defaultBranchBroken,
  isRenovateCommit,
  verdictFor,
  publishedAt,
  refreshMissing,
  securityPrsStuck,
  staleExclusions,
  type Deps,
} from "./checks.ts";
import { DEFAULTS } from "./config.ts";
import type { CheckRun, Commit, PullRequest, Settings } from "./types.ts";

const settings: Settings = { ...DEFAULTS, repos: ["o/r"] };

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Serve a registry document, or an error, without touching the network. */
function stubRegistry(
  body: unknown,
  { ok = true }: { ok?: boolean } = {},
): void {
  globalThis.fetch = (async () => ({
    ok,
    json: async () => body,
  })) as unknown as typeof fetch;
}

describe("publishedAt", () => {
  test("returns the publish time of the exact version", async () => {
    stubRegistry({ time: { "1.2.3": "2026-01-01T00:00:00.000Z" } });
    assert.equal(
      await publishedAt("pkg@1.2.3"),
      Date.parse("2026-01-01T00:00:00.000Z"),
    );
  });

  test("handles scoped names, where @ appears twice", async () => {
    stubRegistry({ time: { "4.5.6": "2026-02-02T00:00:00.000Z" } });
    assert.equal(
      await publishedAt("@scope/pkg@4.5.6"),
      Date.parse("2026-02-02T00:00:00.000Z"),
    );
  });

  test("returns null when the version is absent from the registry", async () => {
    // null means "cannot be dated", which callers must treat as "leave alone" rather than
    // "matured". Removing an entry we cannot date could un-exempt a version that is still young.
    stubRegistry({ time: { "9.9.9": "2026-01-01T00:00:00.000Z" } });
    assert.equal(await publishedAt("pkg@1.2.3"), null);
  });

  test("returns null on a registry error rather than throwing", async () => {
    stubRegistry({}, { ok: false });
    assert.equal(await publishedAt("pkg@1.2.3"), null);
  });

  test("returns null when the network fails", async () => {
    globalThis.fetch = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    assert.equal(await publishedAt("pkg@1.2.3"), null);
  });

  test("returns null for entries without a numeric version", async () => {
    assert.equal(await publishedAt("pkg@workspace:*"), null);
    assert.equal(await publishedAt("no-at-sign"), null);
  });
});


const DAY = 86_400_000;
const ago = (ms: number): string => new Date(Date.now() - ms).toISOString();

const pr = (over: Partial<PullRequest> = {}): PullRequest => ({
  number: 1,
  title: "chore(deps): update x",
  html_url: "https://example/pr/1",
  created_at: ago(10 * DAY),
  labels: [],
  user: { login: "renovate[bot]" },
  head: { ref: "renovate/x", sha: "abc" },
  ...over,
});

const deps = (over: Partial<Deps> = {}): Deps => ({
  openPullRequests: async () => [],
  checkStatus: async () => [],
  gh: async () => [] as never,
  fileContents: async () => null,
  publishedAt: async () => null,
  recentCommits: async () => [],
  strictChecksRequired: async () => false,
  hasLockfile: async () => true,
  ...over,
});

describe("securityPrsStuck", () => {
  const security = pr({ labels: [{ name: "security" }], created_at: ago(3 * DAY) });

  test("reports a labelled Renovate PR past the threshold", async () => {
    const out = await securityPrsStuck("o/r", settings, deps({ openPullRequests: async () => [security] }));
    assert.equal(out.length, 1);
    assert.equal(out[0]!.id, "security-pr:o/r#1");
    assert.equal(out[0]!.sha, "abc");
  });

  test("ignores one that is still within the threshold", async () => {
    const fresh = pr({ labels: [{ name: "security" }], created_at: ago(1 * DAY) });
    assert.deepEqual(await securityPrsStuck("o/r", settings, deps({ openPullRequests: async () => [fresh] })), []);
  });

  test("ignores a scary title without the label", async () => {
    // This is the false-positive that matched nineteen unrelated pull requests during development.
    const scary = pr({ title: "Fix CRITICAL vulnerabilities", labels: [], created_at: ago(9 * DAY) });
    assert.deepEqual(await securityPrsStuck("o/r", settings, deps({ openPullRequests: async () => [scary] })), []);
  });

  test("ignores a labelled PR that is not Renovate's", async () => {
    const human = pr({ labels: [{ name: "security" }], user: { login: "someone" }, head: { ref: "fix/x", sha: "d" }, created_at: ago(9 * DAY) });
    assert.deepEqual(await securityPrsStuck("o/r", settings, deps({ openPullRequests: async () => [human] })), []);
  });

  test("honours a custom label list", async () => {
    const custom = { ...settings, securityLabels: ["vuln"] };
    const tagged = pr({ labels: [{ name: "vuln" }], created_at: ago(3 * DAY) });
    assert.equal((await securityPrsStuck("o/r", custom, deps({ openPullRequests: async () => [tagged] }))).length, 1);
  });
});

describe("automergePrsFailing", () => {
  const old = pr({ created_at: ago(10 * DAY) });

  test("reports a long-failing Renovate PR", async () => {
    const out = await automergePrsFailing("o/r", settings, deps({
      openPullRequests: async () => [old],
      checkStatus: async () => [{ name: "test", conclusion: "failure", steps: 5 }],
    }));
    assert.equal(out.length, 1);
    assert.equal(out[0]!.failing?.[0]?.name, "test");
  });

  test("ignores checks that never started", async () => {
    // Otherwise an unbilled account fires this for every repository at once.
    const out = await automergePrsFailing("o/r", settings, deps({
      openPullRequests: async () => [old],
      checkStatus: async () => [{
        name: "test", conclusion: "failure", steps: 0,
        started: "2026-08-08T12:00:00Z", completed: "2026-08-08T12:00:02Z",
      }],
    }));
    assert.deepEqual(out, []);
  });

  test("ignores a passing PR", async () => {
    const out = await automergePrsFailing("o/r", settings, deps({
      openPullRequests: async () => [old],
      checkStatus: async () => [{ name: "test", conclusion: "success", steps: 3 }],
    }));
    assert.deepEqual(out, []);
  });

  test("ignores pull requests that are not Renovate's", async () => {
    const human = pr({ user: { login: "someone" }, head: { ref: "feature/x", sha: "d" } });
    assert.deepEqual(await automergePrsFailing("o/r", settings, deps({ openPullRequests: async () => [human] })), []);
  });
});

describe("refreshMissing", () => {
  test("does not infer stalled maintenance from missing commits", async () => {
    assert.deepEqual(await refreshMissing("o/r", settings, Date.now() - 40 * DAY, deps()), []);
  });
  test("reports an old open maintenance PR with its actual blocker", async () => {
    const out = await refreshMissing("o/r", { ...settings, checks: { ...settings.checks, failingPrs: false } }, null, deps({
      openPullRequests: async () => [pr({ head: { ref: "renovate/lock-file-maintenance", sha: "abc" }, created_at: ago(20 * DAY) })],
      checkStatus: async () => [{ name: "test", conclusion: "failure" }],
    }));
    assert.equal(out.length, 1);
    assert.equal(out[0]!.number, 1);
    assert.equal(out[0]!.kind, "lockfile maintenance PR unmerged");
    assert.equal(out[0]!.failing?.[0]?.name, "test");
  });
  test("leaves recent maintenance PRs within the threshold", async () => {
    assert.deepEqual(await refreshMissing("o/r", settings, null, deps({
      openPullRequests: async () => [pr({ head: { ref: "renovate/lock-file-maintenance", sha: "abc" } })],
    })), []);
  });
});

describe("staleExclusions", () => {
  const yaml = `minimumReleaseAgeExclude:\n  - old@1.0.0\n  - young@2.0.0\n`;

  test("reports only entries whose version has matured", async () => {
    const out = await staleExclusions("o/r", settings, deps({
      fileContents: async () => yaml,
      publishedAt: async (e) => (e === "old@1.0.0" ? Date.now() - 30 * DAY : Date.now() - DAY),
    }));
    assert.equal(out.length, 1);
    assert.deepEqual(out[0]!.entries, ["old@1.0.0"]);
  });

  test("reports incomplete coverage when an exclusion cannot be dated", async () => {
    // Removing an entry we cannot date could un-exempt a version that is still young and break
    // installs for everyone.
    await assert.rejects(staleExclusions("o/r", settings, deps({
      fileContents: async () => yaml,
      publishedAt: async () => null,
    })), /Cannot determine release age/);
  });

  test("is silent for a repository with no workspace file", async () => {
    assert.deepEqual(await staleExclusions("o/r", settings, deps({ fileContents: async () => null })), []);
  });

  test("is silent when the file has no exclusions", async () => {
    const out = await staleExclusions("o/r", settings, deps({ fileContents: async () => "minimumReleaseAge: 10080\n" }));
    assert.deepEqual(out, []);
  });
});

describe("isRenovateCommit", () => {
  const c = (over: Partial<Commit> = {}): Commit => ({
    sha: "a", message: "chore: something", author: "martinfrancois",
    date: "2026-08-01T00:00:00Z", url: "u", ...over,
  });

  test("recognises the bot by author", () => {
    assert.equal(isRenovateCommit(c({ author: "renovate[bot]" })), true);
  });

  test("recognises a rebase merge landed under a human account", () => {
    // The case this check exists for: the commit is a dependency bump even though a person merged
    // it, so author alone would miss it.
    assert.equal(isRenovateCommit(c({ message: "chore(deps): update dependency uuid to v14" })), true);
    assert.equal(isRenovateCommit(c({ message: "fix(deps): update next [SECURITY]" })), true);
    assert.equal(isRenovateCommit(c({ message: "Lock file maintenance" })), true);
    assert.equal(isRenovateCommit(c({ message: "Pin dependencies" })), true);
  });

  test("does not claim ordinary work", () => {
    assert.equal(isRenovateCommit(c({ message: "feat: add the events page" })), false);
    assert.equal(isRenovateCommit(c({ message: "docs: mention deps in the readme" })), false);
  });
});

describe("verdictFor", () => {
  const run = (over: Partial<CheckRun>): CheckRun => ({ name: "test", conclusion: "success", steps: 3, ...over });
  const withRuns = (runs: CheckRun[]) => deps({ checkStatus: async () => runs });

  test("passing when every check succeeded", async () => {
    assert.equal(await verdictFor("o/r", "s", withRuns([run({})])), "passing");
  });

  test("failing on a real failure", async () => {
    assert.equal(await verdictFor("o/r", "s", withRuns([run({ conclusion: "failure" })])), "failing");
  });

  test("unknown when nothing has run", async () => {
    assert.equal(await verdictFor("o/r", "s", withRuns([])), "unknown");
  });

  test("unknown while a check is still running", async () => {
    // Reporting a branch as broken while CI is mid-flight is the classic false positive.
    assert.equal(await verdictFor("o/r", "s", withRuns([run({ conclusion: null })])), "unknown");
  });

  test("a billing-blocked job is neither a failure nor a pass", async () => {
    const blocked = run({
      conclusion: "failure", steps: 0,
      started: "2026-08-08T12:00:00Z", completed: "2026-08-08T12:00:02Z",
    });
    assert.equal(await verdictFor("o/r", "s", withRuns([blocked])), "unknown");
  });

  test("treats skipped and neutral as passing", async () => {
    const out = await verdictFor("o/r", "s", withRuns([run({ conclusion: "skipped" }), run({ conclusion: "neutral" })]));
    assert.equal(out, "passing");
  });

  test("rejects when the lookup throws", async () => {
    const boom = deps({ checkStatus: async () => { throw new Error("offline"); } });
    await assert.rejects(verdictFor("o/r", "s", boom), /offline/);
  });
});

describe("defaultBranchBroken", () => {
  const commit = (sha: string, message: string, author = "martinfrancois"): Commit => ({
    sha, message, author, date: `2026-08-0${sha.length}T00:00:00Z`, url: `https://gh/${sha}`,
  });
  const bump = (sha: string) => commit(sha, "chore(deps): update dependency uuid to v14", "renovate[bot]");
  const fail: CheckRun[] = [{ name: "test", conclusion: "failure", steps: 4 }];
  const pass: CheckRun[] = [{ name: "test", conclusion: "success", steps: 4 }];

  /** commits newest-first, plus a per-sha verdict. */
  const scenario = (commits: Commit[], status: Record<string, CheckRun[]>, strict = false) =>
    deps({
      recentCommits: async () => commits,
      checkStatus: async (_r, sha) => status[sha] ?? [],
      strictChecksRequired: async () => strict,
    });

  test("reports when a merged dependency commit left the branch red", async () => {
    const out = await defaultBranchBroken("o/r", settings,
      scenario([bump("dep1")], { dep1: fail }));
    assert.equal(out.length, 1);
    assert.equal(out[0]!.kind, "default branch failing after dependency changes");
    assert.equal(out[0]!.sha, "dep1");
    assert.equal(out[0]!.failing?.[0]?.name, "test");
  });

  test("says nothing once a later commit has fixed it", async () => {
    // The whole point: a red Renovate commit followed by a green fix is someone having dealt with
    // it already. Reporting that would be reporting history.
    const out = await defaultBranchBroken("o/r", settings,
      scenario([commit("fix1", "fix: repair the build"), bump("dep1")], { fix1: pass, dep1: fail }));
    assert.deepEqual(out, []);
  });

  test("still reports when the failure continues past the dependency commit", async () => {
    const out = await defaultBranchBroken("o/r", settings,
      scenario([commit("work", "feat: more"), bump("dep1")], { work: fail, dep1: fail }));
    assert.equal(out.length, 1);
    assert.equal(out[0]!.sha, "work", "check links use the current failing head");
    assert.equal(out[0]!.brokenSince?.length, 2);
  });

  test("inspects the current head when multiple dependency commits failed", async () => {
    const out = await defaultBranchBroken("o/r", settings,
      scenario([bump("dep2"), bump("dep1")], { dep2: fail, dep1: fail }));
    assert.equal(out[0]!.sha, "dep2");
  });

  test("stays silent when a person broke it", async () => {
    // Renovate automation working correctly is the subject here; ordinary breakage is not this
    // channel's business and would dilute it.
    const out = await defaultBranchBroken("o/r", settings,
      scenario([commit("human", "feat: rewrite the parser")], { human: fail }));
    assert.deepEqual(out, []);
  });

  test("checks the default branch even with strict rulesets", async () => {
    // Post-merge workflows also run in repositories with strict merge rules.
    const out = await defaultBranchBroken("o/r", settings,
      scenario([bump("dep1")], { dep1: fail }, true));
    assert.equal(out.length, 1);
  });

  test("does not fire on a billing-blocked branch", async () => {
    const blocked: CheckRun[] = [{
      name: "test", conclusion: "failure", steps: 0,
      started: "2026-08-08T12:00:00Z", completed: "2026-08-08T12:00:02Z",
    }];
    const out = await defaultBranchBroken("o/r", settings, scenario([bump("dep1")], { dep1: blocked }));
    assert.deepEqual(out, []);
  });

  test("does not fire while checks are still running", async () => {
    const running: CheckRun[] = [{ name: "test", conclusion: null, steps: 0 }];
    const out = await defaultBranchBroken("o/r", settings, scenario([bump("dep1")], { dep1: running }));
    assert.deepEqual(out, []);
  });

  test("handles a branch with no commits", async () => {
    const out = await defaultBranchBroken("o/r", settings, scenario([], {}));
    assert.deepEqual(out, []);
  });

  test("says the start was not observed when the whole window is failing", async () => {
    // Otherwise the oldest commit fetched is named as the cause when it is only where we stopped
    // looking, which sends someone to the wrong commit.
    const many = Array.from({ length: 20 }, (_, i) => bump(`dep${i}`));
    const status = Object.fromEntries(many.map((c) => [c.sha, fail]));
    const out = await defaultBranchBroken("o/r", settings, scenario(many, status));
    assert.equal(out.length, 1);
    assert.match(out[0]!.threshold!, /start not observed/);
    assert.match(out[0]!.threshold!, /20\+/);
  });

  test("records the boundary when the preceding commit passed", async () => {
    const out = await defaultBranchBroken("o/r", settings,
      scenario([bump("dep1"), commit("green", "feat: fine")], { dep1: fail, green: pass }));
    assert.equal(out.length, 1);
    assert.doesNotMatch(out[0]!.threshold!, /not observed/);
    assert.match(out[0]!.threshold!, /1 commit failing/);
  });

  test("keys the finding on the culprit so it is reported once", async () => {
    const a = await defaultBranchBroken("o/r", settings, scenario([bump("dep1")], { dep1: fail }));
    const b = await defaultBranchBroken("o/r", settings,
      scenario([commit("later", "feat: x"), bump("dep1")], { later: fail, dep1: fail }));
    assert.equal(a[0]!.id, b[0]!.id, "a further failing commit must not re-report the same breakage");
  });
});

describe("refreshMissing and repositories without a lockfile", () => {
  test("says nothing when the repository has no lockfile to refresh", async () => {
    // Maven, Gradle, Ansible and Python repositories here commit no lockfile, so lockFileMaintenance
    // has nothing to do and its silence is correct. Reporting it would fire forever on a third of
    // the fleet, which is how a channel stops being read.
    const out = await refreshMissing("o/r", settings, Date.now() - 400 * DAY, deps({
      hasLockfile: async () => false,
      gh: async () => [] as never,
    }));
    assert.deepEqual(out, []);
  });

  test("still reports a repository that does have one", async () => {
    const out = await refreshMissing("o/r", settings, Date.now() - 400 * DAY, deps({
      hasLockfile: async () => true,
      gh: async () => [] as never,
    }));
    assert.equal(out.length, 0);
  });
});
