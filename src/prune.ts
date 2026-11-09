#!/usr/bin/env node
/**
 * Propose validated PRs removing matured release-age exemptions.
 * A scheduled job avoids making the passage of time fail an unrelated commit's CI.
 */
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { accessSync, constants, lstatSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { loadSettings, workspaceFileFor, statePath } from "./config.ts";
import type { Settings } from "./types.ts";
import { isPnpmExcludeKey, parseExclusions, PNPM_EXCLUDE_KEY, publishedAt } from "./checks.ts";
import {
  assertSameVersions, assertUvOutcome, describeUvEntry, expectedLockAfterPrune, isUvSettingsFile, maturedUvEntries, parseUvExclusions,
  assertVisible, PREFLIGHT, removeUvEntries, sandboxArgs, sandboxedUv, uvCooldownMs,
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
  const start = lines.findIndex(isPnpmExcludeKey);
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
  try {
    await validatePnpm(path.dirname(full));
  } catch (error) {
    writeFileSync(full, text);
    throw new Error(
      `refusing to push: pnpm rejected the edited ${file}. ${(error as Error).message.slice(0, 300)}`,
    );
  }
  // Only the workspace file should change; a lockfile touched here would mean the edit altered
  // resolution, which a matured-entry removal must never do.
  await assertChangedFiles(dir, [file], [file]);
  const prUrl = await publishPrune(repo, dir, {
    file,
    staged: [file],
    searchFor: pnpmSearchTerms(matured, next),
    validation: "the edited YAML retains exactly the expected exclusions, and pnpm install --lockfile-only --ignore-scripts --ignore-pnpmfile accepts it without changing other files.",
  }, matured, settings);
  return { repo, pruned: matured, prUrl };
}

/** What a pnpm prune PR asks the reviewer to look for: the entries, and the key once removeEntries dropped it with its last entry. */
export function pnpmSearchTerms(matured: string[], editedText: string): string[] {
  return parseExclusions(editedText).length ? matured : [...matured, PNPM_EXCLUDE_KEY];
}

type PnpmRunner = (command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => Promise<unknown>;

/** Global pnpm settings can point at a store outside the service's writable paths. */
export async function validatePnpm(cwd: string, execute: PnpmRunner = run): Promise<void> {
  const store = mkdtempSync(path.join(tmpdir(), "prune-pnpm-"));
  try {
    await execute("pnpm", ["install", "--lockfile-only", "--ignore-scripts", "--store-dir", store, "--ignore-pnpmfile"], {
      cwd, env: { ...process.env, CI: "1" },
    });
  } catch (error) {
    const e = error as { stderr?: string; stdout?: string; message?: string };
    throw new Error(e.stderr || e.stdout || e.message || "unknown error");
  } finally {
    rmSync(store, { recursive: true, force: true });
  }
}

/**
 * Prune uv's exclude-newer-package table and re-lock.
 *
 * Unlike pnpm's list, the table is recorded in uv.lock, so the lock changes too. uv re-locks a copy
 * of the two files and must accept the result with --check, every locked package version must be
 * unchanged, and the new lock must equal the old one minus exactly the removed entries. A version
 * change would mean the entry was still holding something back, which a matured entry must never
 * do.
 *
 * This job holds GitHub credentials, and uv can run code from the repository or a release even
 * with --no-build: it runs the project environment's interpreter, follows .python-version to an
 * executable, and builds the root project for dynamic metadata (measured with uv 0.13.0). So uv
 * gets a copy of the two files, a pinned system interpreter, and a PREFLIGHT that refuses anything
 * it would have to build, and all of it runs inside bubblewrap; see sandboxArgs. The pnpm prune
 * passes --ignore-scripts for the same reason.
 */
async function pruneUv(repo: string, dir: string, file: string, text: string, settings: Settings): Promise<PruneResult> {
  const full = path.join(dir, file);
  const entries = parseUvExclusions(text);
  const cooldown = uvCooldownMs(text) ?? settings.thresholds.cooldownDays * 24 * 3600_000;
  const matured = maturedUvEntries(entries, cooldown, Date.now());
  if (!matured.length) return { repo, pruned: [] };
  const labels = matured.map(describeUvEntry);
  if (DRY_RUN) return { repo, pruned: labels, dryRun: true };

  const lockFile = path.posix.join(path.posix.dirname(file), UV_LOCK);
  const lockBefore = readFileSync(path.join(dir, lockFile), "utf8");
  const names = matured.map((e) => e.name);
  const next = removeUvEntries(text, names);
  assertUvOutcome(entries, names, next, file);
  const expectedLock = expectedLockAfterPrune(lockBefore, names);

  const relocked = await relockInSandbox(next, lockBefore, settings.uvCommand, file);
  assertSameVersions(lockBefore, relocked, labels);
  if (relocked !== expectedLock) {
    throw new Error(
      `refusing to push: uv's re-lock of ${file} differs from the old ${lockFile} by more than ` +
        `the removed entries (${labels.join(", ")})`,
    );
  }
  writeFileSync(full, next);
  writeFileSync(path.join(dir, lockFile), expectedLock);
  const changed = await assertChangedFiles(dir, [file, lockFile], [file, lockFile]);
  const prUrl = await publishPrune(repo, dir, {
    file,
    staged: changed,
    // removeUvEntries keeps the table header, so unlike pnpm's key it is never removed.
    searchFor: uvSearchTerms(names),
    validation: `the edited ${file} retains exactly the expected entries; uv lock and uv lock --check, run in a sandbox on a copy of both files, accept it; the re-locked ${lockFile} differs only by the removed entries, so every locked version is unchanged; and no other file changed.`,
  }, labels, settings);
  return { repo, pruned: labels, prUrl };
}

/** Find an executable the way a shell would, so the sandbox can mount the real file. */
function which(command: string): string {
  if (path.isAbsolute(command)) return realpathSync(command);
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    const candidate = path.join(dir, command);
    try {
      accessSync(candidate, constants.X_OK);
      return realpathSync(candidate);
    } catch {
      // not in this directory
    }
  }
  throw new Error(`${command} is not on PATH`);
}

const UV_LOCK = "uv.lock";

/** Run uv lock and uv lock --check in bubblewrap on a copy of the two files; return the new lock. */
async function relockInSandbox(pyproject: string, lock: string, uvCommand: string, file: string): Promise<string> {
  let bwrap: string;
  try {
    bwrap = which("bwrap");
  } catch {
    throw new Error(
      "refusing to run uv: bubblewrap (bwrap) is not installed. The uv prune runs uv inside it, " +
        "because uv can run code from the repository or a release with this job's credentials",
    );
  }
  const uv = which(uvCommand);
  const scratch = mkdtempSync(path.join(tmpdir(), "prune-uv-"));
  try {
    const work = path.join(scratch, "work");
    const cache = path.join(scratch, "cache");
    mkdirSync(work);
    mkdirSync(cache);
    writeFileSync(path.join(work, "pyproject.toml"), pyproject);
    writeFileSync(path.join(work, UV_LOCK), lock);
    // A system interpreter only, found with a system PATH and no project files, so neither the
    // operator's shell setup nor the repository steers the choice.
    const found = (await run(uv, ["python", "find", "--no-project", "--system"], {
      cwd: work, env: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: process.env.HOME ?? "" },
    })).stdout.trim();
    const python = realpathSync(found);
    assertVisible(python);
    const rootLinks: Record<string, string | null> = {};
    for (const dir of ["/bin", "/sbin", "/lib", "/lib64"]) {
      try {
        rootLinks[dir] = lstatSync(dir).isSymbolicLink() ? readlinkSync(dir) : null;
      } catch {
        // absent on this host
      }
    }
    const paths = { work, cache, uv, rootLinks };
    const steps: [string, string[], boolean][] = [
      ["refused", [python, "-I", "-c", PREFLIGHT], false],
      ["rejected", sandboxedUv(["lock"], python), true],
      ["rejected", sandboxedUv(["lock", "--check"], python), true],
    ];
    for (const [verb, argv, network] of steps) {
      await run(bwrap, sandboxArgs(paths, argv, network), { maxBuffer: 8 * 1024 * 1024 }).catch((error: { stderr?: string; message?: string }) => {
        throw new Error(`refusing to push: uv ${verb} the edited ${file}. ${String(error.stderr || error.message).trim().slice(0, 300)}`);
      });
    }
    return readFileSync(path.join(work, UV_LOCK), "utf8");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
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

/**
 * What a prune changed and how it was checked, as the commit and the PR should describe it, and
 * what the reviewer should search the rest of the repository for.
 */
export type PruneChange = { file: string; staged: string[]; validation: string; searchFor: string[] };

/** A noisy repository could otherwise bury the rest of the PR body under its hits. */
export const REFERENCE_LIMIT = 30;
/** A minified file can match with a line of megabytes; GitHub rejects a body over 65,536 characters. */
export const REFERENCE_WIDTH = 200;
// A matured version legitimately stays locked, so lockfile hits are not leftovers.
const LOCKFILES = ["pnpm-lock.yaml", UV_LOCK, "package-lock.json", "yarn.lock", "bun.lock"];

/**
 * `path:line:text` for every tracked line that still names a removed exemption or the removed key.
 *
 * The prune may only change its own files, and rewriting free text is not an edit it can parse and
 * check, so comments, tests and ADRs that describe a removed exemption are listed in the PR for the
 * reviewer instead. Run after the edit is written: the removed block is gone from the working tree,
 * so only the text that stays behind matches. -i lets a uv name match however it is capitalised.
 */
export async function findStaleReferences(dir: string, needles: string[], execute: PruneRunner = publishCommand): Promise<string[]> {
  if (!needles.length) return [];
  const excluded = LOCKFILES.map((f) => `:(exclude,glob)**/${f}`);
  // -z separates path, line number and text with NUL, so the name check sees only the text.
  const args = ["-c", "grep.heading=false", "-c", "grep.column=false", "grep", "--no-color", "-z", "-n", "-I", "-F", "-i",
    ...needles.flatMap((n) => ["-e", n]), "--", ".", ...excluded];
  try {
    const whole = needles.map(wholeName);
    return (await execute("git", args, dir)).split("\n")
      .map((hit) => hit.split("\0"))
      .filter(([, , text]) => text !== undefined && whole.some((name) => name.test(text)))
      .map((fields) => fields.join(":"));
  } catch (error) {
    // git grep exits 1 when nothing matches.
    if ((error as { code?: unknown }).code === 1) return [];
    throw error;
  }
}

/**
 * Matches the needle only where it is not part of a longer package name or version: grep -w
 * treats "-" as a boundary, so example-pkg@1.2.3 would match other-example-pkg@1.2.3, and it
 * would also take example-pkg@1.2.30 or "six" in "sixty" without the check after the name.
 * A trailing period that ends a sentence still counts as a boundary.
 */
function wholeName(needle: string): RegExp {
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![A-Za-z0-9_.@/-])${escaped}(?![A-Za-z0-9_-]|\\.[A-Za-z0-9])`, "i");
}

/** uv treats "-", "_" and "." in a name as the same character (PEP 503), and prose uses all three. */
export function uvSearchTerms(names: string[]): string[] {
  return [...new Set(names.flatMap((name) => ["-", "_", "."].map((separator) => name.replaceAll(/[-_.]+/g, separator))))];
}

/** A fence one backtick longer than any run in the text, so a stray fence cannot close the block. */
function codeBlock(text: string): string {
  const longestRun = Math.max(2, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(longestRun + 1);
  return `${fence}\n${text}\n${fence}`;
}

/**
 * The hits go in a code block, so an @mention, an issue number or a stray fence in a matched line
 * is shown as text instead of notifying someone, linking an issue or swallowing the rest of the body.
 */
async function referencesSection(dir: string, needles: string[], execute: PruneRunner): Promise<string> {
  let references: string[];
  try { references = await findStaleReferences(dir, needles, execute); }
  catch (error) {
    // The list only helps the reviewer, so a failed search must not stop a validated prune.
    return `\n\nThe search for leftover references to the removed exemptions failed:\n\n${codeBlock((error as Error).message.slice(0, REFERENCE_WIDTH))}`;
  }
  if (!references.length) return "";
  const shown = references.slice(0, REFERENCE_LIMIT).map((r) => (r.length > REFERENCE_WIDTH ? `${r.slice(0, REFERENCE_WIDTH)}...` : r));
  const more = references.length - shown.length;
  // Only the prose is wrapped: a wrapped hit line would break its path.
  return "\n\nReferences to check\n\n" +
    wrapBody("These lines still mention a removed exemption or the removed key. The prune does not edit them; update or delete the ones about the exemption before merging. Lines that only use the package, such as imports, need no change.") +
    `\n\n${codeBlock(shown.join("\n"))}` +
    (more ? `\n\n${more} more not shown.` : "");
}

/** Every prune PR's branch starts with this, which is how the notification sweep recognises one. */
export const PRUNE_BRANCH_PREFIX = "watchdog/prune-";

export async function publishPrune(repo: string, dir: string, change: PruneChange, matured: string[], settings: Settings, execute: PruneRunner = publishCommand): Promise<string> {
  const { file } = change;
  const branch = `${PRUNE_BRANCH_PREFIX}${createHash("sha256").update(JSON.stringify([file, [...matured].sort()])).digest("hex").slice(0, 12)}`;
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
  const prBody = `${body}${await referencesSection(dir, change.searchFor, execute)}\n\nThe operator reviews this PR before merging.`;
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
