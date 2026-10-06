import test from "node:test";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { hasPlatform, mirror, planCopies, planRetention, snapshotDate, SOURCE, type PackageVersion, type Run } from "./tumbleweed-mirror.ts";

const day = (tag: string): number => snapshotDate(tag)!;
const version = (id: number, name: string, ...tags: string[]): PackageVersion => ({ id, name, metadata: { container: { tags } } });
const sha = (raw: string): string => `sha256:${createHash("sha256").update(raw).digest("hex")}`;
const index = (...arches: string[]) => JSON.stringify({ manifests: arches.map((a) => ({ digest: `sha256:${a}-child`, platform: { os: "linux", architecture: a } })) });

test("only real YYYYMMDD dates are snapshots", () => {
  assert.equal(snapshotDate("20261003"), Date.UTC(2026, 9, 3));
  for (const tag of ["20261003.37.215", "latest", "20261332", "20260230", "2026103"]) assert.equal(snapshotDate(tag), null);
});

test("copies new snapshots from the last two weeks, oldest first", () => {
  const upstream = ["latest", "20261003", "20260929", "20261003.37.215", "20260921", "20260922", "20261001"];
  assert.deepEqual(planCopies(upstream, new Set(["20261001"]), day("20261006")), ["20260922", "20260929", "20261003"]);
});

test("needs a linux image of the architecture", () => {
  assert.equal(hasPlatform(JSON.parse(index("386", "amd64")), "amd64"), true);
  assert.equal(hasPlatform(JSON.parse(index("s390x")), "amd64"), false);
  assert.equal(hasPlatform({}, "amd64"), false);
});

test("retention counts 60 days back from the newest snapshot and spares other tags", () => {
  const versions = [version(1, "sha256:new", "20261003"), version(2, "sha256:edge", "20260804"), version(3, "sha256:old", "20260803"), version(4, "sha256:pinned", "20260701", "keep"), version(5, "sha256:child")];
  const { expired, kept } = planRetention(versions);
  assert.deepEqual(expired.map((v) => v.id), [3]);
  assert.deepEqual(kept.map((v) => v.id), [1, 2, 4]);
  assert.deepEqual(planRetention([version(6, "sha256:x", "latest")]), { expired: [], kept: [version(6, "sha256:x", "latest")] });
});

/** A fake registry pair and package API. Records every command so the tests can see what was written. */
function world(opts: { upstream: Record<string, string>; packages: PackageVersion[] | null; copyDigest?: string; deleteFails?: string }) {
  const calls: string[][] = [];
  let packages = opts.packages;
  let nextId = 100;
  const run: Run = async (cmd, args) => {
    calls.push([cmd, ...args]);
    const ref = args[1] ?? "";
    if (cmd === "crane" && args[0] === "ls") return Object.keys(opts.upstream).join("\n") + "\nlatest\n";
    if (cmd === "crane" && args[0] === "digest") return `${opts.copyDigest ?? sha(opts.upstream[ref.split(":").pop()!]!)}\n`;
    if (cmd === "crane" && args[0] === "manifest" && ref.startsWith(SOURCE)) return opts.upstream[ref.split(":").pop()!]!;
    if (cmd === "crane" && args[0] === "manifest") return index("amd64");
    if (cmd === "crane" && args[0] === "copy") {
      const tag = args[2]!.split(":").pop()!;
      packages = [...(packages ?? []), version(nextId++, sha(opts.upstream[tag]!), tag)];
      return "";
    }
    if (cmd === "gh" && args[1] === "-X") {
      if (opts.deleteFails) throw new Error(opts.deleteFails);
      const id = Number(args[3]!.split("/").pop());
      packages = (packages ?? []).filter((v) => v.id !== id);
      return "";
    }
    if (cmd === "gh") {
      if (packages === null) throw new Error("gh api: Package not found. (HTTP 404)");
      return JSON.stringify([packages]);
    }
    throw new Error(`unexpected ${cmd} ${args.join(" ")}`);
  };
  return { run, calls, packages: () => packages };
}

test("first run creates the mirror from amd64 snapshots only, copying by digest", async () => {
  const w = world({ upstream: { "20260928": index("s390x"), "20260929": index("386", "amd64"), "20261003": index("amd64", "arm64") }, packages: null });
  const lines: string[] = [];
  const report = await mirror({ owner: "Owner", now: day("20261006"), run: w.run, log: (l) => lines.push(l) });
  assert.deepEqual(report.copied, ["20260929", "20261003"]);
  assert.deepEqual(report.skipped, ["20260928"]);
  assert.ok(w.calls.some((c) => c.join(" ") === `crane copy ${SOURCE}@${sha(index("386", "amd64"))} ghcr.io/owner/tumbleweed:20260929`));
  assert.ok(lines.some((l) => l.startsWith("skip 20260928")));
});

test("a later run copies only what is new, prunes expired versions and their orphaned children", async () => {
  const w = world({
    upstream: { "20260929": index("amd64"), "20261003": index("amd64") },
    packages: [version(1, "sha256:20260929", "20260929"), version(2, "sha256:20260701", "20260701"), version(3, "sha256:amd64-child"), version(4, "sha256:orphan")],
  });
  const report = await mirror({ owner: "owner", now: day("20261006"), run: w.run, log: () => {} });
  assert.deepEqual(report.copied, ["20261003"]);
  assert.deepEqual(report.deleted, ["20260701"]);
  assert.deepEqual(report.deletedUntagged, ["sha256:orphan"]);
  assert.deepEqual(w.packages()!.map((v) => v.id).sort(), [1, 100, 3]);
});

test("dry run writes nothing", async () => {
  const w = world({ upstream: { "20261003": index("amd64") }, packages: [version(2, "sha256:20260701", "20260701"), version(1, "sha256:20261002", "20261002"), version(3, "sha256:orphan")] });
  const report = await mirror({ owner: "owner", now: day("20261006"), dryRun: true, run: w.run, log: () => {} });
  assert.deepEqual([report.copied, report.deleted, report.deletedUntagged], [["20261003"], ["20260701"], ["sha256:orphan"]]);
  assert.ok(!w.calls.some((c) => c[1] === "copy" || c[2] === "-X"));
});

test("a copy whose digest differs from upstream fails the run", async () => {
  const w = world({ upstream: { "20261003": index("amd64") }, packages: [], copyDigest: "sha256:rewritten" });
  await assert.rejects(mirror({ owner: "owner", now: day("20261006"), run: w.run, log: () => {} }), /expected the upstream sha256:[0-9a-f]{64}/);
});

test("errors other than a missing package or version abort the run", async () => {
  const failing: Run = async (cmd) => { if (cmd === "gh") throw new Error("gh api: Bad credentials (HTTP 401)"); return ""; };
  await assert.rejects(mirror({ owner: "owner", run: failing, log: () => {} }), /HTTP 401/);
  const gone = world({ upstream: {}, packages: [version(1, "sha256:20261003", "20261003"), version(2, "sha256:20260701", "20260701")], deleteFails: "gh api: Not Found (HTTP 404)" });
  // A version that is already gone counts as deleted.
  assert.deepEqual((await mirror({ owner: "owner", now: day("20261006"), run: gone.run, log: () => {} })).deleted, ["20260701"]);
  const denied = world({ upstream: {}, packages: [version(1, "sha256:20261003", "20261003"), version(2, "sha256:20260701", "20260701")], deleteFails: "gh api: Forbidden (HTTP 403)" });
  await assert.rejects(mirror({ owner: "owner", now: day("20261006"), run: denied.run, log: () => {} }), /HTTP 403/);
  await assert.rejects(mirror({ owner: "a/b", run: failing, log: () => {} }), /GitHub account name/);
});

test("the outcome check fails when a kept snapshot disappears", async () => {
  const w = world({ upstream: {}, packages: [version(1, "sha256:20261003", "20261003"), version(2, "sha256:20260701", "20260701")] });
  const vanishing: Run = async (cmd, args) => {
    const out = await w.run(cmd, args);
    // Simulate the registry losing the kept version together with the expired one.
    if (cmd === "gh" && args[1] === "-X") await w.run("gh", ["api", "-X", "DELETE", "x/1"]);
    return out;
  };
  await assert.rejects(mirror({ owner: "owner", now: day("20261006"), run: vanishing, log: () => {} }), /missing after the run: 20261003/);
});
