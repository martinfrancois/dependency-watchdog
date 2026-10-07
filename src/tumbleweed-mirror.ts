import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";

// Why this mirror exists, and why these numbers: docs/tumbleweed-mirror.md.
export const SOURCE = "registry.opensuse.org/opensuse/tumbleweed";
export const PACKAGE = "tumbleweed";
export const KEEP_DAYS = 60;
// amd64 is gone after 7 to 8 days, so an older tag that was never copied never will be.
export const COPY_DAYS = 14;
export const REQUIRED_ARCH = "amd64";
const DAY = 86_400_000;

/** Runs a command and returns its stdout. Injectable so the plan can be tested without crane, gh or a network. */
export type Run = (cmd: string, args: string[]) => Promise<string>;
export type PackageVersion = { id: number; name: string; metadata?: { container?: { tags?: string[] } } };
type Index = { manifests?: { digest: string; platform?: { os?: string; architecture?: string } }[] };

const exec = promisify(execFile);
const defaultRun: Run = async (cmd, args) => {
  try {
    return (await exec(cmd, args, { timeout: 600_000, maxBuffer: 64 * 1024 * 1024 })).stdout;
  } catch (error) {
    const e = error as { stderr?: string; message: string };
    throw new Error(`${cmd} ${args.join(" ")}: ${e.stderr?.trim() || e.message}`);
  }
};

/** Epoch milliseconds of a YYYYMMDD snapshot tag, or null for build tags (20261003.37.215), latest and the rest. */
export function snapshotDate(tag: string): number | null {
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(tag);
  if (!m) return null;
  const [year, month, day] = [Number(m[1]), Number(m[2]) - 1, Number(m[3])];
  const date = new Date(Date.UTC(year, month, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month && date.getUTCDate() === day ? date.getTime() : null;
}

export const tagsOf = (v: PackageVersion): string[] => v.metadata?.container?.tags ?? [];

/** Snapshot tags from the last COPY_DAYS that are not mirrored yet, oldest first. */
export function planCopies(upstream: string[], mirrored: Set<string>, now: number): string[] {
  const oldest = now - COPY_DAYS * DAY;
  return upstream
    .filter((tag) => !mirrored.has(tag) && (snapshotDate(tag) ?? -Infinity) >= oldest)
    .sort();
}

export function hasPlatform(index: Index, arch: string): boolean {
  return Boolean(index.manifests?.some((m) => m.platform?.os === "linux" && m.platform.architecture === arch));
}

/**
 * Splits tagged versions into expired and kept. The window counts back from the newest mirrored
 * snapshot, not from today, so a mirror whose source stops publishing keeps its last 60 days
 * instead of emptying itself, and the version with the newest date is always kept. A version
 * carrying any tag that is not an expired snapshot date stays.
 */
export function planRetention(versions: PackageVersion[]): { expired: PackageVersion[]; kept: PackageVersion[] } {
  const tagged = versions.filter((v) => tagsOf(v).length > 0);
  const dates = tagged.flatMap(tagsOf).map(snapshotDate).filter((d): d is number => d !== null);
  if (dates.length === 0) return { expired: [], kept: tagged };
  const cutoff = Math.max(...dates) - KEEP_DAYS * DAY;
  const expired = tagged.filter((v) => tagsOf(v).every((tag) => (snapshotDate(tag) ?? Infinity) < cutoff));
  return { expired, kept: tagged.filter((v) => !expired.includes(v)) };
}

export type MirrorReport = { copied: string[]; skipped: string[]; deleted: string[]; deletedUntagged: string[]; dryRun: boolean };

export async function mirror({ owner, now = Date.now(), dryRun = false, run = defaultRun, log = console.log }: {
  owner: string; now?: number; dryRun?: boolean; run?: Run; log?: (line: string) => void;
}): Promise<MirrorReport> {
  if (!/^[A-Za-z0-9-]+$/.test(owner)) throw new Error(`Expected a GitHub account name, got "${owner}"`);
  const target = `ghcr.io/${owner.toLowerCase()}/${PACKAGE}`;
  const api = `/users/${owner}/packages/container/${PACKAGE}/versions`;
  const listVersions = async (): Promise<PackageVersion[]> => {
    try {
      return (JSON.parse(await run("gh", ["api", `${api}?per_page=100`, "--paginate", "--slurp"])) as PackageVersion[][]).flat();
    } catch (error) {
      // The package does not exist until the first copy creates it.
      if (/HTTP 404/.test((error as Error).message)) return [];
      throw error;
    }
  };
  const report: MirrorReport = { copied: [], skipped: [], deleted: [], deletedUntagged: [], dryRun };

  const upstream = (await run("crane", ["ls", SOURCE])).split("\n").map((t) => t.trim()).filter(Boolean);
  const mirrored = new Set((await listVersions()).flatMap(tagsOf));
  for (const tag of planCopies(upstream, mirrored, now)) {
    // One request per tag: the digest is the hash of the manifest bytes. Copying by that digest
    // means a tag moving mid-run cannot mix two snapshots.
    const raw = await run("crane", ["manifest", `${SOURCE}:${tag}`]);
    const digest = `sha256:${createHash("sha256").update(raw, "utf8").digest("hex")}`;
    const index = JSON.parse(raw) as Index;
    if (!hasPlatform(index, REQUIRED_ARCH)) {
      // registry.opensuse.org deletes amd64 first; a tag left with only other architectures is no use to an amd64 pin.
      report.skipped.push(tag);
      log(`skip ${tag}: no linux/${REQUIRED_ARCH} image in ${digest}`);
      continue;
    }
    if (dryRun) { report.copied.push(tag); log(`would copy ${tag} ${digest}`); continue; }
    await run("crane", ["copy", `${SOURCE}@${digest}`, `${target}:${tag}`]);
    const copied = (await run("crane", ["digest", `${target}:${tag}`])).trim();
    if (copied !== digest) throw new Error(`${target}:${tag} is ${copied}, expected the upstream ${digest}`);
    report.copied.push(tag);
    log(`copied ${tag} ${digest}`);
  }

  const versions = await listVersions();
  const { expired, kept } = planRetention(versions);
  // Per-architecture manifests are untagged versions of their own; keep every one a kept index still references.
  const referenced = new Set<string>();
  for (const v of kept) {
    for (const m of (JSON.parse(await run("crane", ["manifest", `${target}@${v.name}`])) as Index).manifests ?? []) referenced.add(m.digest);
  }
  const deleteVersion = async (v: PackageVersion): Promise<void> => {
    if (dryRun) return;
    try {
      await run("gh", ["api", "-X", "DELETE", `${api}/${v.id}`]);
    } catch (error) {
      if (!/HTTP 404/.test((error as Error).message)) throw error;
    }
  };
  for (const v of expired) {
    await deleteVersion(v);
    report.deleted.push(...tagsOf(v));
    log(`${dryRun ? "would delete" : "deleted"} ${tagsOf(v).join(",")} ${v.name}`);
  }
  for (const v of versions.filter((v) => tagsOf(v).length === 0 && !referenced.has(v.name))) {
    await deleteVersion(v);
    report.deletedUntagged.push(v.name);
    log(`${dryRun ? "would delete" : "deleted"} untagged ${v.name}`);
  }

  if (!dryRun) {
    // Positive check: every snapshot meant to stay is still there after the deletions.
    const after = new Set((await listVersions()).flatMap(tagsOf));
    const missing = [...kept.flatMap(tagsOf), ...report.copied].filter((tag) => !after.has(tag));
    if (missing.length > 0) throw new Error(`Mirrored tags missing after the run: ${missing.join(", ")}`);
  }
  return report;
}

export async function runMirror(run: Run = defaultRun): Promise<void> {
  const owner = process.env.GITHUB_REPOSITORY_OWNER ?? "";
  const report = await mirror({ owner, dryRun: process.argv.includes("--dry-run"), run });
  console.log(JSON.stringify(report));
}
