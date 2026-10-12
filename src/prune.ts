#!/usr/bin/env node
/**
 * Propose validated PRs removing matured release-age exemptions.
 * A scheduled job avoids making the passage of time fail an unrelated commit's CI.
 */
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { loadSettings, workspaceFileFor, statePath } from "./config.ts";
import type { Settings } from "./types.ts";
import { parseExclusions, publishedAt } from "./checks.ts";
import {
  assertSameVersions, assertUvOutcome, describeUvEntry, uvBuildBlockers, isUvSettingsFile, maturedUvEntries, parseUvExclusions,
  removeUvEntries, uvCooldownMs,
} from "./uv.ts";

const run = promisify(execFile);
const DRY_RUN = process.argv.includes("--dry-run");


async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await run("git", args, { cwd, maxBuffer: 32 * 1024 * 1024 });
  return stdout.trim();
}

/**
 * Drop the listed entries, and the whole key if that empties it.
 *
 * The block scanner must accept comments and blank lines between items, not only list items.
 * An earlier version stopped at the first comment, concluded the list was empty, deleted the key
 * and left every entry orphaned with nothing to attach to. pnpm then refused to parse the file at
 * all, which took two repositories' main branches down. Hence the parse check in pruneRepo, and
 * hence the comment-aware scan here.
 */
export function removeEntries(yamlText: string, doomed: string[]): string {
  const lines = yamlText.split("\n");
  const start = lines.findIndex((l) => /^minimumReleaseAgeExclude:\s*$/.test(l));
  if (start === -1) return yamlText;

  const isItem = (l: string): boolean => /^\s+-\s/.test(l);
  const isComment = (l: string): boolean => /^\s*#/.test(l);
  const isBlank = (l: string): boolean => /^\s*$/.test(l);

  // Consume the block: items, plus comments and blanks that sit between them. Stop at the first
  // line that is none of those, or at a line at column zero, which starts the next top-level key.
  let end = start + 1;
  let lastItem = start;
  while (end < lines.length) {
    const line = lines[end] ?? "";
    if (isItem(line)) {
      lastItem = end;
      end++;
      continue;
    }
    if ((isComment(line) || isBlank(line)) && !/^\S/.test(line)) {
      end++;
      continue;
    }
    if (isComment(line) && end < lines.length - 1) {
      // A column-zero comment may belong to the next key. Only absorb it if an item follows.
      let look = end + 1;
      while (
        look < lines.length &&
        (isComment(lines[look] ?? "") || isBlank(lines[look] ?? ""))
      )
        look++;
      if (look < lines.length && isItem(lines[look] ?? "")) {
        end++;
        continue;
      }
    }
    break;
  }
  end = lastItem + 1; // never swallow trailing comments that belong to whatever comes next

  const body = lines.slice(start + 1, end);
  const entryOf = (l: string): string => l.trim().slice(2).trim().replace(/^["']|["']$/g, "");
  // A comment that names a removed entry describes that entry (Renovate writes one per security
  // fix), so it goes with it. Comments that name nothing are general and stay.
  const namesDoomed = (l: string): boolean => doomed.some((entry) => l.includes(entry));
  const kept = body.filter((l) => (isItem(l) ? !doomed.includes(entryOf(l)) : !namesDoomed(l)));
  const keptItems = kept.filter(isItem);

  // An empty key is not valid here, so remove the key and its comments when the last entry goes.
  // The column-zero comment lines directly above the key belong to it, the way YAML comments are
  // read, and left behind they would describe entries that no longer exist. Dropping the key and
  // its comment can leave two blank lines in a row where there was one; keep one.
  let cut = start;
  if (!keptItems.length) {
    while (cut > 0 && /^#/.test(lines[cut - 1] ?? "")) cut--;
    if (isBlank(lines[cut - 1] ?? "x") && isBlank(lines[end] ?? "x")) end++;
  }
  const replacement = keptItems.length ? [lines[start] ?? "", ...kept] : [];
  return [...lines.slice(0, cut), ...replacement, ...lines.slice(end)].join("\n");
}

/**
 * Wrap prose at 72 columns, the width git itself recommends for a commit body.
 *
 * A monitored repository enforces commitlint's 100 character body limit and rejected a prune
 * commit whose summary line ran past it, so the commit body is wrapped before it is written.
 * List items and lines that already fit are left as they are.
 */
export function wrapBody(text: string, width = 72): string {
  return text
    .split("\n")
    .flatMap((line) => {
      if (line.length <= width || /^\s*-\s/.test(line)) return [line];
      const wrapped: string[] = [];
      let current = "";
      for (const word of line.split(" ")) {
        if (current && current.length + 1 + word.length > width) {
          wrapped.push(current);
          current = word;
        } else {
          current = current ? `${current} ${word}` : word;
        }
      }
      if (current) wrapped.push(current);
      return wrapped;
    })
    .join("\n");
}

type PruneResult = { repo: string; pruned?: string[]; skipped?: string; error?: string; dryRun?: boolean; prUrl?: string };

/**
 * Choose which exclusion entries have aged past the cooldown and may be removed.
 *
 * An entry whose publish time cannot be determined is left alone, deliberately. Removing one could
 * un-exempt a version that is in fact still young, which would break installs for everyone. The
 * cost of keeping a stale entry is that the cooldown is slightly weaker for one package; the cost
 * of removing a young one is a broken repository.
 */
export async function selectMatured(
  entries: string[],
  cutoffMs: number,
  lookup: (entry: string) => Promise<number | null>,
  now: number = Date.now(),
): Promise<string[]> {
  const matured: string[] = [];
  for (const entry of entries) {
    const published = await lookup(entry);
    if (published !== null && now - published >= cutoffMs) matured.push(entry);
  }
  return matured;
}

/**
 * Assert that an edited file still contains exactly the entries it should.
 *
 * This is the check that would have caught the incident that prompted all of these guards. A
 * broken scanner deleted the minimumReleaseAgeExclude key while leaving every entry orphaned
 * beneath it, so re-parsing yielded an empty list where fifteen entries were expected. Comparing
 * the parsed outcome against the intended outcome catches structural damage whatever its cause,
 * without having to anticipate the shape of the bug.
 */
export function assertPruneOutcome(
  before: string[],
  removed: string[],
  editedText: string,
  file = "the file",
): void {
  const expected = before.filter((e) => !removed.includes(e)).sort();
  const actual = parseExclusions(editedText).sort();
  const same =
    expected.length === actual.length && expected.every((e, i) => e === actual[i]);
  if (!same) {
    throw new Error(
      `refusing to write ${file}: expected ${expected.length} entries to remain ` +
        `(${expected.join(", ") || "none"}) but the edited file parses as ${actual.length} ` +
        `(${actual.join(", ") || "none"}). The edit damaged the file rather than pruning it.`,
    );
  }
}

async function pruneRepo(repo: string, settings: Settings): Promise<PruneResult> {
  const file = workspaceFileFor(settings, repo);
  const dir = mkdtempSync(path.join(tmpdir(), "prune-"));
  try {
    await git(dir, "clone", ...(DRY_RUN ? ["--depth", "1"] : []), "--quiet", `https://github.com/${repo}.git`, ".");
    let text: string;
    try {
      text = readFileSync(path.join(dir, file), "utf8");
    } catch {
      return { repo, skipped: "no workspace file" };
    }
    return isUvSettingsFile(file)
      ? await pruneUv(repo, dir, file, text, settings)
      : await prunePnpm(repo, dir, file, text, settings);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function prunePnpm(repo: string, dir: string, file: string, text: string, settings: Settings): Promise<PruneResult> {
  const full = path.join(dir, file);
  const cutoff = settings.thresholds.cooldownDays * 24 * 3600_000;
  const entries = parseExclusions(text);
  if (!entries.length) return { repo, pruned: [] };

  const matured = await selectMatured(entries, cutoff, publishedAt);
  if (!matured.length) return { repo, pruned: [] };

  if (DRY_RUN) return { repo, pruned: matured, dryRun: true };

  const next = removeEntries(text, matured);

  // Guard one: the edit removed exactly the entries we chose, and nothing else.
  assertPruneOutcome(entries, matured, next, file);

  // Guard two: never push a file this process cannot itself parse. Nothing between "edit the
  // text" and "git push" used to look at the result, which is how a regex bug became two dead
  // main branches. pnpm is the authority on this file, so ask pnpm.
  writeFileSync(full, next);
  const check = await run("pnpm", ["install", "--lockfile-only", "--ignore-scripts"], {
    cwd: path.dirname(full),
    env: { ...process.env, CI: "1" },
  }).catch((e: { stderr?: string; message?: string }) => ({
    failed: true as const,
    message: e.stderr || e.message || "unknown error",
  }));
  if ("failed" in check && check.failed) {
    writeFileSync(full, text);
    throw new Error(
      `refusing to push: pnpm rejected the edited ${file}. ${String(check.message).slice(0, 300)}`,
    );
  }
  // Only the workspace file should change; a lockfile touched here would mean the edit altered
  // resolution, which a matured-entry removal must never do.
  await assertChangedFiles(dir, [file], [file]);
  const prUrl = await publishPrune(repo, dir, {
    file,
    staged: [file],
    validation: "the edited YAML retains exactly the expected exclusions, and pnpm install --lockfile-only --ignore-scripts accepts it without changing other files.",
  }, matured, settings);
  return { repo, pruned: matured, prUrl };
}

/**
 * Prune uv's exclude-newer-package table and re-lock.
 *
 * Unlike pnpm's list, the table is recorded in uv.lock, so the lock changes too and the guard is
 * different: uv must re-lock and accept the result with --check, and the set of locked package
 * versions must be identical before and after. A version change would mean the entry was still
 * holding something back, which is exactly what a matured entry must never do.
 *
 * This job holds GitHub credentials, so uv must run no code from the repository or a release.
 * The pnpm prune passes --ignore-scripts for the same reason. Measured with uv 0.13.0, three ways
 * in, each closed separately:
 * - A source distribution's build: --no-build.
 * - The interpreter. uv runs the project environment's python (.venv/bin/python) to read its
 *   version even when --python names another, and follows .python-version to an executable when
 *   it does not. Hence a trusted interpreter found outside the clone, and a project environment
 *   path in a private directory that does not exist.
 * - The project's own build backend, which uv runs to read dynamic metadata despite --no-build.
 *   uvBuildBlockers refuses those files before uv sees them.
 */
async function pruneUv(repo: string, dir: string, file: string, text: string, settings: Settings): Promise<PruneResult> {
  const full = path.join(dir, file);
  const entries = parseUvExclusions(text);
  const cooldown = uvCooldownMs(text) ?? settings.thresholds.cooldownDays * 24 * 3600_000;
  const matured = maturedUvEntries(entries, cooldown, Date.now());
  if (!matured.length) return { repo, pruned: [] };
  const labels = matured.map(describeUvEntry);
  if (DRY_RUN) return { repo, pruned: labels, dryRun: true };

  const blockers = uvBuildBlockers(text);
  if (blockers.length) {
    throw new Error(
      `refusing to run uv on ${file}: ${blockers.join("; ")}. uv would build the project or a ` +
        "local source to read its metadata, which runs repository code with this job's credentials",
    );
  }
  const lockFile = path.posix.join(path.posix.dirname(file), "uv.lock");
  const lockBefore = readFileSync(path.join(dir, lockFile), "utf8");
  const names = matured.map((e) => e.name);
  const next = removeUvEntries(text, names);
  assertUvOutcome(entries, names, next, file);
  writeFileSync(full, next);

  const outside = mkdtempSync(path.join(tmpdir(), "prune-uv-"));
  try {
    const python = (await run(settings.uvCommand, ["python", "find", "--no-project"], { cwd: outside })).stdout.trim();
    const env = { ...process.env, UV_PROJECT_ENVIRONMENT: path.join(outside, "absent") };
    const uv = (args: string[]) =>
      run(settings.uvCommand, [...args, "--no-build", "--python", python], { cwd: path.dirname(full), env, maxBuffer: 8 * 1024 * 1024 });
    await uv(["lock"]);
    await uv(["lock", "--check"]);
  } catch (error) {
    const e = error as { stderr?: string; message?: string };
    throw new Error(`refusing to push: uv rejected the edited ${file}. ${String(e.stderr || e.message).slice(0, 300)}`);
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
  assertSameVersions(lockBefore, readFileSync(path.join(dir, lockFile), "utf8"), labels);
  const changed = await assertChangedFiles(dir, [file, lockFile], [file]);
  const prUrl = await publishPrune(repo, dir, {
    file,
    staged: changed,
    validation: `the edited ${file} retains exactly the expected entries, uv lock --no-build and uv lock --check accept it, every locked package version is unchanged, and no file besides ${changed.join(" and ")} changed.`,
  }, labels, settings);
  return { repo, pruned: labels, prUrl };
}

/**
 * Require the working tree to differ only in `allowed`, and in every file of `required`.
 *
 * Ask git for bare paths rather than parsing porcelain by column offset. The status line is
 * "XY path", so the path begins at column 3, but git() trims its output and the leading space of
 * an unstaged change goes with it, which silently ate the first character of every path and made
 * this guard reject a correct edit as "unexpected changes beyond ...: npm-workspace.yaml".
 */
async function assertChangedFiles(dir: string, allowed: string[], required: string[]): Promise<string[]> {
  const tracked = await git(dir, "diff", "--name-only", "HEAD");
  const untracked = await git(dir, "ls-files", "--others", "--exclude-standard");
  const changed = [...tracked.split("\n"), ...untracked.split("\n")]
    .map((l) => l.trim())
    .filter(Boolean);
  const unexpected = changed.filter((f) => !allowed.includes(f));
  if (unexpected.length) {
    throw new Error(
      `refusing to push: unexpected changes beyond ${allowed.join(", ")}: ${unexpected.join(", ")}`,
    );
  }
  const missing = required.filter((f) => !changed.includes(f));
  if (missing.length) throw new Error(`refusing to push: the edit left ${missing.join(", ")} unchanged`);
  return changed.sort();
}

export class PrunePushRejected extends Error {}
export type PruneRunner = (command: string, args: string[], cwd: string) => Promise<string>;
const publishCommand: PruneRunner = async (command, args, cwd) =>
  (await run(command, args, { cwd, timeout: 180_000, maxBuffer: 8 * 1024 * 1024 })).stdout.trim();

/** What a prune changed and how it was checked, as the commit and the PR should describe it. */
export type PruneChange = { file: string; staged: string[]; validation: string };

export async function publishPrune(repo: string, dir: string, change: PruneChange, matured: string[], settings: Settings, execute: PruneRunner = publishCommand): Promise<string> {
  const { file } = change;
  const branch = `watchdog/prune-${createHash("sha256").update(JSON.stringify([file, [...matured].sort()])).digest("hex").slice(0, 12)}`;
  const existing = JSON.parse(await execute("gh", ["pr", "list", "--repo", repo, "--head", branch, "--state", "open", "--json", "url"], dir)) as { url: string }[];
  if (existing[0]) return existing[0].url;
  const base = (await execute("git", ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], dir)).replace(/^origin\//, "");
  await execute("git", ["switch", "-c", branch], dir);
  await execute("git", ["config", "user.name", settings.commitName ?? ""], dir);
  await execute("git", ["config", "user.email", settings.commitEmail ?? ""], dir);
  await execute("git", ["add", ...change.staged], dir);
  const stat = await execute("git", ["diff", "--cached", "--stat"], dir);
  console.log(stat);
  const staged = await execute("git", ["diff", "--cached", "--name-only"], dir);
  const expected = [...change.staged].sort().join("\n");
  if (staged.split("\n").map((l) => l.trim()).filter(Boolean).sort().join("\n") !== expected) {
    throw new Error(`refusing to commit unexpected staged files: ${staged}`);
  }
  const title = "chore(deps): prune matured release-age exclusions";
  const noun = matured.length === 1 ? "exemption" : "exemptions";
  const body = wrapBody(
    `Removes ${matured.length} release-age ${noun} from ${file} after the configured cooldown expired.\n\n` +
      matured.map((m) => `- ${m}`).join("\n") +
      `\n\nValidation: ${change.validation}`,
  );
  await execute("git", ["commit", "-q", "-m", title, "-m", body], dir);
  try { await execute("git", ["push", "-u", "origin", branch], dir); }
  catch (error) { throw new PrunePushRejected(`Push stopped for ${repo}: ${(error as Error).message}`); }
  const prBody = `${body}\n\nThe operator reviews this PR before merging.`;
  return await execute("gh", ["pr", "create", "--repo", repo, "--base", base, "--head", branch, "--title", title, "--body", prBody], dir);
}

export async function runPrune(): Promise<void> {
  const startedAt = new Date().toISOString();
  const settings = loadSettings();
  if (!DRY_RUN && (!settings.commitName || !settings.commitEmail)) {
    throw new Error(
      'Set "commitName" and "commitEmail" in the settings file before the prune may push. ' +
        "Commits need an author, and guessing one would attribute automated changes to whoever " +
        "happens to be configured on the machine.",
    );
  }
  const results: PruneResult[] = [];
  for (const repo of settings.repos) {
    try {
      results.push(await pruneRepo(repo, settings));
    } catch (error) {
      results.push({ repo, error: (error as Error).message });
      process.exitCode = 1;
      if (error instanceof PrunePushRejected) break;
    }
  }

  for (const r of results) {
    if (r.error) console.error(`  ${r.repo}: FAILED ${r.error}`);
    else if (r.skipped) console.log(`  ${r.repo}: ${r.skipped}`);
    else if (!r.pruned?.length) console.log(`  ${r.repo}: nothing to prune`);
    else {
      console.log(
        `  ${r.repo}: ${r.dryRun ? "would prune" : "proposed pruning"} ${r.pruned?.length}: ${r.pruned?.join(", ")}`,
      );
      if (r.prUrl) console.log(`  review ${r.prUrl}`);
    }
  }

  if (DRY_RUN) return;
  savePruneReport({ startedAt, finishedAt: new Date().toISOString(), results });
  if (process.exitCode === 1) throw new Error("one or more repositories failed");
  // Only the daily watchdog may acknowledge its heartbeat. A prune must not mask its failure.
}

export function savePruneReport(report: { startedAt: string; finishedAt: string; results: PruneResult[] }): void {
  const file = path.join(path.dirname(statePath()), "last-prune.json");
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(`${file}.tmp`, JSON.stringify(report, null, 2), { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
}
