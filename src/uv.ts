/**
 * uv's counterpart to pnpm's `minimumReleaseAgeExclude`.
 *
 * A repository gates uv with a relative cutoff in pyproject.toml and exempts a security fix with a
 * per-package cutoff just past the fixed version's last upload:
 *
 *     [tool.uv]
 *     exclude-newer = "7 days"
 *
 *     [tool.uv.exclude-newer-package]
 *     # ruff 0.17.0: security fix.
 *     ruff = "2026-10-09T19:47:30Z"
 *
 * uv has no exact-version exception, so the entry is a date, and the date is all the watchdog
 * needs: once it is a full cooldown old, the global cutoff admits every file the entry admitted,
 * and removing it changes no resolution. No registry lookup is involved. Until then the entry also
 * holds its package at the fixed version, so one left in place stops that package from moving.
 *
 * Only the table form above is read. TOML also allows the same setting as an inline table or a
 * dotted key; those are refused rather than read as "no entries", because a parser that silently
 * sees nothing would make the stale check blind and the prune's outcome check vacuous.
 */
import path from "node:path";

export const UV_TABLE = "[tool.uv.exclude-newer-package]";

export type UvEntry = { name: string; value: string };

/** A repository's exclusion file is uv's when it is a pyproject.toml; anything else is pnpm's. */
export function isUvSettingsFile(file: string): boolean {
  return path.posix.basename(file) === "pyproject.toml";
}

const HEADER = /^\s*\[\[?([^\]]+)\]\]?\s*(#.*)?$/;
// uv 0.13 accepts a string or `false` here and fails to parse `true`, numbers and bare dates, so
// anything else in the table is damage.
const ENTRY = /^\s*(?:"([^"]+)"|([A-Za-z0-9_-]+))\s*=\s*(?:"([^"]*)"|(false))\s*(#.*)?$/;
const OTHER_FORM = /^\s*(?:tool\s*\.\s*uv\s*\.\s*)?exclude-newer-package\s*[.=]/;

/** Index of the table header and of the first line after the table, or null when absent. */
function tableBounds(lines: string[]): { start: number; end: number } | null {
  const start = lines.findIndex((l) => l.trim() === UV_TABLE);
  if (start === -1) return null;
  let end = start + 1;
  while (end < lines.length && !HEADER.test(lines[end] ?? "")) end++;
  return { start, end };
}

/** PEP 503 normalisation, which is how uv compares package names. */
export function normalizeName(name: string): string {
  return name.replace(/[-_.]+/g, "-").toLowerCase();
}

/** The entries of `[tool.uv.exclude-newer-package]`, in file order. */
export function parseUvExclusions(text: string): UvEntry[] {
  const lines = text.split("\n");
  const bounds = tableBounds(lines);
  const outside = lines.filter((_, i) => !bounds || i < bounds.start || i >= bounds.end);
  if (outside.some((l) => OTHER_FORM.test(l))) {
    throw new Error(
      `exclude-newer-package is written in a form other than a ${UV_TABLE} table; ` +
        "only the table form can be checked and pruned",
    );
  }
  if (!bounds) return [];
  const out: UvEntry[] = [];
  for (const line of lines.slice(bounds.start + 1, bounds.end)) {
    if (/^\s*(#.*)?$/.test(line)) continue;
    const m = ENTRY.exec(line);
    if (!m) throw new Error(`cannot read this line of ${UV_TABLE}: ${line.trim()}`);
    out.push({ name: normalizeName(m[1] ?? m[2] ?? ""), value: m[3] ?? m[4] ?? "" });
  }
  return out;
}

/** The global cooldown from `[tool.uv] exclude-newer`, in milliseconds, or null if not relative. */
export function uvCooldownMs(text: string): number | null {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => /^\s*\[tool\.uv\]\s*(#.*)?$/.test(l));
  if (start === -1) return null;
  for (const line of lines.slice(start + 1)) {
    if (HEADER.test(line)) break;
    const m = /^\s*exclude-newer\s*=\s*"([^"]*)"/.exec(line);
    if (m) return parseSpan(m[1] ?? "");
  }
  return null;
}

const HOUR = 3600_000;
const UNIT: Record<string, number> = { hour: HOUR, day: 24 * HOUR, week: 7 * 24 * HOUR };

/** "7 days", "1 week", "168 hours", "P7D", "P1W", "PT12H"; anything else is not a span. */
export function parseSpan(value: string): number | null {
  const friendly = /^\s*(\d+)\s*(hour|day|week)s?\s*$/i.exec(value);
  if (friendly) return Number(friendly[1]) * (UNIT[friendly[2]!.toLowerCase()] ?? NaN);
  const iso = /^P(?:(\d+)W)?(?:(\d+)D)?(?:T(\d+)H)?$/i.exec(value.trim());
  if (iso && (iso[1] || iso[2] || iso[3])) {
    return Number(iso[1] ?? 0) * UNIT.week! + Number(iso[2] ?? 0) * UNIT.day! + Number(iso[3] ?? 0) * HOUR;
  }
  return null;
}

/** Milliseconds since the epoch for an RFC 3339 timestamp with a zone, else null. */
function instant(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/i.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Entries whose cutoff is at least one cooldown old.
 *
 * A value that is not a timestamp (`false`, a relative span) is never selected. Those are not what
 * a security exception looks like, so they are someone's deliberate setting, and the cost of
 * leaving one is a weaker gate for one package while the cost of removing one is a broken lock.
 */
export function maturedUvEntries(entries: UvEntry[], cooldownMs: number, now: number): UvEntry[] {
  return entries.filter((e) => {
    const at = instant(e.value);
    return at !== null && now - at >= cooldownMs;
  });
}

/** How an entry is named in findings, commit bodies and logs. */
export function describeUvEntry(entry: UvEntry): string {
  return `${entry.name} ${entry.value}`;
}

/**
 * Remove the named entries, each with the comment that describes it.
 *
 * Entries are written as their own paragraph: a blank line, a comment, the entry. When an entry's
 * comment block has a blank line above it, the whole paragraph goes. When it does not, the block
 * may be the table's own header comment, so only comment lines that name the package go with it.
 */
export function removeUvEntries(text: string, names: string[]): string {
  const lines = text.split("\n");
  const bounds = tableBounds(lines);
  if (!bounds) return text;
  const doomed = new Set(names.map(normalizeName));
  const drop = new Set<number>();
  for (let i = bounds.start + 1; i < bounds.end; i++) {
    const m = ENTRY.exec(lines[i] ?? "");
    const name = m ? normalizeName(m[1] ?? m[2] ?? "") : null;
    if (!name || !doomed.has(name)) continue;
    drop.add(i);
    let top = i;
    while (top - 1 > bounds.start && /^\s*#/.test(lines[top - 1] ?? "")) top--;
    if (top - 1 > bounds.start && /^\s*$/.test(lines[top - 1] ?? "")) {
      for (let j = top - 1; j < i; j++) drop.add(j);
    } else {
      const mentions = new RegExp(`(^|[^A-Za-z0-9_.-])${escape(name)}([^A-Za-z0-9_.-]|$)`, "i");
      for (let j = top; j < i; j++) if (mentions.test(normalizeName(lines[j] ?? ""))) drop.add(j);
    }
  }
  return lines.filter((_, i) => !drop.has(i)).join("\n");
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Re-parse the edited file and require exactly the entries that should remain.
 *
 * The same guard as the pnpm prune's: compare the parsed outcome with the intended one, so damage
 * of any shape is caught, not only the shapes anticipated when the remover was written.
 */
export function assertUvOutcome(before: UvEntry[], removed: string[], editedText: string, file: string): void {
  const gone = new Set(removed.map(normalizeName));
  const key = (e: UvEntry): string => `${e.name}=${e.value}`;
  const expected = before.filter((e) => !gone.has(e.name)).map(key).sort();
  let actual: string[];
  try {
    actual = parseUvExclusions(editedText).map(key).sort();
  } catch (error) {
    throw new Error(`refusing to write ${file}: the edited file no longer parses: ${(error as Error).message}`);
  }
  if (expected.length !== actual.length || expected.some((e, i) => e !== actual[i])) {
    throw new Error(
      `refusing to write ${file}: expected ${expected.length} entries to remain ` +
        `(${expected.join(", ") || "none"}) but the edited file parses as ${actual.length} ` +
        `(${actual.join(", ") || "none"}). The edit damaged the file rather than pruning it.`,
    );
  }
}

/**
 * Every `name==version` in a uv.lock, sorted.
 *
 * Each `[[package]]` starts with its name and version; sub-tables such as
 * `[package.optional-dependencies]` follow and are skipped.
 */
export function lockedVersions(lockText: string): string[] {
  const out: string[] = [];
  let current: { name: string; version: string } | null = null;
  const flush = (): void => {
    if (current) out.push(`${current.name}==${current.version}`);
    current = null;
  };
  let inPackage = false;
  for (const line of lockText.split("\n")) {
    if (line.trim() === "[[package]]") {
      flush();
      current = { name: "", version: "" };
      inPackage = true;
      continue;
    }
    if (HEADER.test(line)) {
      inPackage = false;
      continue;
    }
    if (!inPackage || !current) continue;
    const m = /^(name|version)\s*=\s*"([^"]*)"/.exec(line);
    if (m) current[m[1] as "name" | "version"] = m[2] ?? "";
  }
  flush();
  return out.sort();
}

/** Refuse a re-lock that moved any package: removing a matured entry must change no resolution. */
export function assertSameVersions(lockBefore: string, lockAfter: string, removed: string[]): void {
  const before = lockedVersions(lockBefore);
  const after = lockedVersions(lockAfter);
  const lost = before.filter((v) => !after.includes(v));
  const gained = after.filter((v) => !before.includes(v));
  if (lost.length || gained.length) {
    throw new Error(
      `refusing to push: removing ${removed.join(", ")} changed locked versions ` +
        `(removed ${lost.join(", ") || "none"}; added ${gained.join(", ") || "none"})`,
    );
  }
}

/**
 * The uv.lock a prune expects: the same file without the removed entries in its
 * `[options.exclude-newer-package]` table, and without the table once it is empty.
 *
 * uv's own re-lock must produce exactly this. Comparing the whole file, not only versions, means
 * nothing uv or code running under it wrote can reach the commit except what the prune intended.
 */
export function expectedLockAfterPrune(lockText: string, names: string[]): string {
  const doomed = new Set(names.map(normalizeName));
  const lines = lockText.split("\n");
  const start = lines.findIndex((l) => l.trim() === "[options.exclude-newer-package]");
  if (start === -1) return lockText;
  let end = start + 1;
  while (end < lines.length && !HEADER.test(lines[end] ?? "")) end++;
  const drop = new Set<number>();
  let kept = 0;
  for (let i = start + 1; i < end; i++) {
    const m = ENTRY.exec(lines[i] ?? "");
    if (!m) continue;
    if (doomed.has(normalizeName(m[1] ?? m[2] ?? ""))) drop.add(i);
    else kept++;
  }
  if (!kept) for (let i = start; i < end; i++) drop.add(i);
  return lines.filter((_, i) => !drop.has(i)).join("\n");
}

export type SandboxPaths = {
  /** Directory holding only the edited pyproject.toml and the current uv.lock. */
  work: string;
  /** Fresh uv cache for this run, so nothing a run writes there is read by the next. */
  cache: string;
  /** Resolved uv executable, mounted read-only. */
  uv: string;
  /**
   * How the host's top-level /bin, /sbin, /lib and /lib64 look: a symlink target (merged /usr)
   * or null for a real directory, which is then mounted read-only. Absent entries are skipped.
   */
  rootLinks: Record<string, string | null>;
};

/**
 * bubblewrap arguments that run a command with no access to this job's credentials.
 *
 * The sandbox sees /usr, the loader paths, the resolver files, a copy of the two files, a
 * throwaway cache and uv, and nothing else: no home, no configuration directory, no runtime
 * sockets. The environment is cleared. The network is shared only when uv needs the index.
 */
export function sandboxArgs(p: SandboxPaths, argv: string[], network: boolean): string[] {
  const args = ["--die-with-parent", "--unshare-all", ...(network ? ["--share-net"] : [])];
  args.push("--ro-bind", "/usr", "/usr");
  for (const [dir, target] of Object.entries(p.rootLinks)) {
    if (target === null) args.push("--ro-bind", dir, dir);
    else args.push("--symlink", target, dir);
  }
  args.push("--ro-bind-try", "/etc/resolv.conf", "/etc/resolv.conf", "--ro-bind-try", "/etc/hosts", "/etc/hosts");
  args.push("--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp");
  args.push("--bind", p.work, "/tmp/work", "--bind", p.cache, "/tmp/cache");
  args.push("--ro-bind", p.uv, "/tmp/bin/uv");
  args.push("--clearenv", "--setenv", "PATH", "/usr/bin", "--setenv", "HOME", "/tmp/work");
  args.push("--setenv", "UV_CACHE_DIR", "/tmp/cache", "--chdir", "/tmp/work");
  return [...args, ...argv];
}

/** uv inside the sandbox, never building, with the given interpreter. */
export function sandboxedUv(uvArgs: string[], python: string): string[] {
  return ["/tmp/bin/uv", ...uvArgs, "--no-build", "--python", python];
}

/**
 * Python, run offline in the sandbox before uv, that refuses a pyproject.toml uv would have to
 * build to read. uv builds the root project for dynamic metadata even with --no-build, and needs a
 * build for local, Git and URL sources, so any of those means code from the repository or a
 * download would run. tomllib reads every TOML spelling of a key, which a line scan cannot.
 */
export const PREFLIGHT = `
import tomllib
with open("pyproject.toml", "rb") as f:
    data = tomllib.load(f)
project = data.get("project")
uv = data.get("tool", {}).get("uv", {})
bad = []
if not isinstance(project, dict):
    bad.append("no [project] table")
else:
    if project.get("dynamic"):
        bad.append("dynamic metadata (" + ", ".join(map(str, project["dynamic"])) + ")")
    if "version" not in project:
        bad.append("no static version")
if uv.get("sources"):
    bad.append("uv sources")
if "workspace" in uv:
    bad.append("a uv workspace")
requirements = list(project.get("dependencies", [])) if isinstance(project, dict) else []
if isinstance(project, dict):
    for group in project.get("optional-dependencies", {}).values():
        requirements += group
for group in data.get("dependency-groups", {}).values():
    requirements += group
requirements += uv.get("dev-dependencies", [])
for requirement in requirements:
    if isinstance(requirement, str) and "@" in requirement.split(";")[0]:
        bad.append("direct reference " + requirement)
if bad:
    raise SystemExit("; ".join(bad))
`;

/**
 * The interpreter must be one the sandbox shows anyway, under /usr. Mounting one from elsewhere
 * would re-expose whatever lives beside it, a whole home directory for a ~/bin/python.
 */
export function assertVisible(python: string): void {
  if (!python.startsWith("/usr/")) {
    throw new Error(
      `refusing to run uv: the interpreter ${python} is outside /usr, the only tree the sandbox ` +
        "shows. Install a system Python in /usr/bin or /usr/local/bin",
    );
  }
}
