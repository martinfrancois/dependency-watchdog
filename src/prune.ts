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
  const kept = body.filter(
    (l) =>
      !isItem(l) ||
      !doomed.includes(l.trim().slice(2).trim().replace(/^["']|["']$/g, "")),
  );
  const keptItems = kept.filter(isItem);

  // An empty key is not valid here, so remove the key and its comments when the last entry goes.
  const replacement = keptItems.length ? [lines[start] ?? "", ...kept] : [];
  return [...lines.slice(0, start), ...replacement, ...lines.slice(end)].join("\n");
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
  const cutoff = settings.thresholds.cooldownDays * 24 * 3600_000;
  const dir = mkdtempSync(path.join(tmpdir(), "prune-"));
  try {
    await git(dir, "clone", ...(DRY_RUN ? ["--depth", "1"] : []), "--quiet", `https://github.com/${repo}.git`, ".");
    const full = path.join(dir, file);
    let text: string;
    try {
      text = readFileSync(full, "utf8");
    } catch {
      return { repo, skipped: "no workspace file" };
    }

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
    // Ask git for bare paths rather than parsing porcelain by column offset. The status line is
    // "XY path", so the path begins at column 3, but git() trims its output and the leading space
    // of an unstaged change goes with it, which silently ate the first character of every path and
    // made this guard reject a correct edit as "unexpected changes beyond ...: npm-workspace.yaml".
    const tracked = await git(dir, "diff", "--name-only", "HEAD");
    const untracked = await git(dir, "ls-files", "--others", "--exclude-standard");
    const changed = [...tracked.split("\n"), ...untracked.split("\n")]
      .map((l) => l.trim())
      .filter(Boolean);
    const unexpected = changed.filter((f) => f !== file);
    if (unexpected.length) {
      throw new Error(
        `refusing to push: unexpected changes beyond ${file}: ${unexpected.join(", ")}`,
      );
    }
    const prUrl = await publishPrune(repo, dir, file, matured, settings);
    return { repo, pruned: matured, prUrl };

  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export class PrunePushRejected extends Error {}
export type PruneRunner = (command: string, args: string[], cwd: string) => Promise<string>;
const publishCommand: PruneRunner = async (command, args, cwd) =>
  (await run(command, args, { cwd, timeout: 180_000, maxBuffer: 8 * 1024 * 1024 })).stdout.trim();

export async function publishPrune(repo: string, dir: string, file: string, matured: string[], settings: Settings, execute: PruneRunner = publishCommand): Promise<string> {
  const branch = `watchdog/prune-${createHash("sha256").update(JSON.stringify([file, [...matured].sort()])).digest("hex").slice(0, 12)}`;
  const existing = JSON.parse(await execute("gh", ["pr", "list", "--repo", repo, "--head", branch, "--state", "open", "--json", "url"], dir)) as { url: string }[];
  if (existing[0]) return existing[0].url;
  const base = (await execute("git", ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], dir)).replace(/^origin\//, "");
  await execute("git", ["switch", "-c", branch], dir);
  await execute("git", ["config", "user.name", settings.commitName ?? ""], dir);
  await execute("git", ["config", "user.email", settings.commitEmail ?? ""], dir);
  await execute("git", ["add", file], dir);
  const stat = await execute("git", ["diff", "--cached", "--stat"], dir);
  console.log(stat);
  const staged = await execute("git", ["diff", "--cached", "--name-only"], dir);
  if (staged.trim() !== file) throw new Error(`refusing to commit unexpected staged files: ${staged}`);
  const title = "chore(deps): prune matured release-age exclusions";
  const body = `Removes ${matured.length} release-age exemptions from ${file} after their configured cooldown expired.\n\n` +
    matured.map((m) => `- ${m}`).join("\n") +
    "\n\nValidation: the edited YAML retains exactly the expected exclusions; pnpm install --lockfile-only --ignore-scripts accepts it without changing other files.\n\nThe operator reviews this PR before merging.";
  await execute("git", ["commit", "-q", "-m", title, "-m", body], dir);
  try { await execute("git", ["push", "-u", "origin", branch], dir); }
  catch (error) { throw new PrunePushRejected(`Push stopped for ${repo}: ${(error as Error).message}`); }
  return await execute("gh", ["pr", "create", "--repo", repo, "--base", base, "--head", branch, "--title", title, "--body", body], dir);
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
