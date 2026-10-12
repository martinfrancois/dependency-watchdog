import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  assertSameVersions, assertUvOutcome, isUvSettingsFile, lockedVersions, maturedUvEntries, parseSpan, parseUvExclusions,
  removeUvEntries, assertVisible, expectedLockAfterPrune, PREFLIGHT, sandboxArgs, sandboxedUv, uvCooldownMs,
} from "./uv.ts";

const DAY = 86_400_000;

/** Shaped like a real pyproject.toml after two security fixes went through. */
const pyproject = `[project]
name = "example"
dependencies = ["pillow==12.3.0"]

[tool.uv]
# Release-age cooldown for every resolution uv makes.
exclude-newer = "7 days"

[tool.uv.exclude-newer-package]
# Security fixes younger than the cooldown. Machine-written; see the tool's docs.

# ruff 0.17.0: security fix, https://github.com/o/r/pull/1. Prune after 2026-10-16T19:47:30Z.
ruff = "2026-10-09T19:47:30Z"

# iniconfig 2.3.1: security fix. Prune after 2026-10-13T22:48:39Z.
iniconfig = "2026-10-06T22:48:39Z"

[tool.ruff]
line-length = 100
`;

describe("isUvSettingsFile", () => {
  test("a pyproject.toml anywhere is uv's, everything else pnpm's", () => {
    assert.equal(isUvSettingsFile("pyproject.toml"), true);
    assert.equal(isUvSettingsFile("backend/pyproject.toml"), true);
    assert.equal(isUvSettingsFile("pnpm-workspace.yaml"), false);
    assert.equal(isUvSettingsFile("frontend/pnpm-workspace.yaml"), false);
  });
});

describe("parseUvExclusions", () => {
  test("reads entries between comments and stops at the next table", () => {
    assert.deepEqual(parseUvExclusions(pyproject), [
      { name: "ruff", value: "2026-10-09T19:47:30Z" },
      { name: "iniconfig", value: "2026-10-06T22:48:39Z" },
    ]);
  });

  test("returns nothing when the table is absent", () => {
    assert.deepEqual(parseUvExclusions('[tool.uv]\nexclude-newer = "7 days"\n'), []);
  });

  test("normalises names and keeps non-timestamp values as written", () => {
    const text = '[tool.uv.exclude-newer-package]\n"Typing_Extensions" = "2026-01-01T00:00:00Z"\nfoo = false # off\n';
    assert.deepEqual(parseUvExclusions(text), [
      { name: "typing-extensions", value: "2026-01-01T00:00:00Z" },
      { name: "foo", value: "false" },
    ]);
  });

  test("refuses the inline-table and dotted-key forms rather than reading them as empty", () => {
    assert.throws(() => parseUvExclusions('[tool.uv]\nexclude-newer-package = { ruff = "2026-01-01T00:00:00Z" }\n'), /other than/);
    assert.throws(() => parseUvExclusions('[tool.uv]\nexclude-newer-package.ruff = "2026-01-01T00:00:00Z"\n'), /other than/);
  });

  test("refuses a line in the table it cannot read", () => {
    assert.throws(() => parseUvExclusions("[tool.uv.exclude-newer-package]\nruff = {\n"), /cannot read/);
  });
});

describe("uvCooldownMs and parseSpan", () => {
  test("reads the relative exclude-newer from [tool.uv]", () => {
    assert.equal(uvCooldownMs(pyproject), 7 * DAY);
  });

  test("is null for an absolute date or a missing setting", () => {
    assert.equal(uvCooldownMs('[tool.uv]\nexclude-newer = "2026-01-01T00:00:00Z"\n'), null);
    assert.equal(uvCooldownMs('[project]\nname = "x"\n'), null);
    assert.equal(uvCooldownMs('[tool.uv]\n[tool.other]\nexclude-newer = "7 days"\n'), null);
  });

  test("understands the friendly and ISO 8601 spans", () => {
    for (const [span, days] of [["7 days", 7], ["1 week", 7], ["168 hours", 7], ["P7D", 7], ["P1W", 7], ["P1DT24H", 2]] as const) {
      assert.equal(parseSpan(span), days * DAY, span);
    }
    assert.equal(parseSpan("P"), null);
    assert.equal(parseSpan("soon"), null);
  });
});

describe("maturedUvEntries", () => {
  const now = Date.parse("2026-10-14T00:00:00Z");
  const entries = parseUvExclusions(pyproject);

  test("selects only entries a full cooldown old", () => {
    assert.deepEqual(maturedUvEntries(entries, 7 * DAY, now).map((e) => e.name), ["iniconfig"]);
  });

  test("treats exactly one cooldown as matured", () => {
    assert.deepEqual(maturedUvEntries(entries, now - Date.parse("2026-10-06T22:48:39Z"), now).map((e) => e.name), ["iniconfig"]);
  });

  test("never selects a value that is not a timestamp", () => {
    const odd = [{ name: "a", value: "false" }, { name: "b", value: "30 days" }, { name: "c", value: "2026-01-01" }];
    assert.deepEqual(maturedUvEntries(odd, 0, now), []);
  });
});

describe("removeUvEntries", () => {
  test("removes an entry with its comment paragraph and nothing else", () => {
    const out = removeUvEntries(pyproject, ["iniconfig"]);
    assert.equal(out, pyproject.replace(
      "\n# iniconfig 2.3.1: security fix. Prune after 2026-10-13T22:48:39Z.\niniconfig = \"2026-10-06T22:48:39Z\"\n",
      "",
    ));
  });

  test("removing every entry keeps the table and its header comment", () => {
    const out = removeUvEntries(pyproject, ["ruff", "iniconfig"]);
    assert.deepEqual(parseUvExclusions(out), []);
    assert.ok(out.includes("[tool.uv.exclude-newer-package]\n# Security fixes younger than the cooldown."));
    assert.ok(out.includes("\n\n[tool.ruff]\nline-length = 100\n"));
  });

  test("keeps a header comment directly above an entry unless it names the package", () => {
    const text = "[tool.uv.exclude-newer-package]\n# General note.\n# ruff: fix\nruff = \"2026-01-01T00:00:00Z\"\nother = \"2026-01-02T00:00:00Z\"\n";
    assert.equal(removeUvEntries(text, ["ruff"]), "[tool.uv.exclude-newer-package]\n# General note.\nother = \"2026-01-02T00:00:00Z\"\n");
  });

  test("matches names the way uv does", () => {
    const text = '[tool.uv.exclude-newer-package]\n\n# typing_extensions: fix\n"typing_extensions" = "2026-01-01T00:00:00Z"\n';
    assert.equal(removeUvEntries(text, ["Typing.Extensions"]), "[tool.uv.exclude-newer-package]\n");
  });

  test("is a no-op without the table or a match", () => {
    assert.equal(removeUvEntries('[project]\nname = "x"\n', ["ruff"]), '[project]\nname = "x"\n');
    assert.equal(removeUvEntries(pyproject, ["absent"]), pyproject);
  });
});

describe("assertUvOutcome", () => {
  const before = parseUvExclusions(pyproject);

  test("accepts the remover's own output", () => {
    assert.doesNotThrow(() => assertUvOutcome(before, ["iniconfig"], removeUvEntries(pyproject, ["iniconfig"]), "pyproject.toml"));
  });

  /**
   * The negative control. A remover that drops the table header orphans every remaining entry under
   * [tool.uv], which uv would read as unknown settings, the same shape as the pnpm incident.
   */
  test("rejects an edit that lost the table header", () => {
    const damaged = removeUvEntries(pyproject, ["iniconfig"]).replace("[tool.uv.exclude-newer-package]\n", "");
    assert.throws(() => assertUvOutcome(before, ["iniconfig"], damaged, "pyproject.toml"), /expected 1 entries to remain .* parses as 0/);
  });

  test("rejects an edit that kept what it should have removed or changed a date", () => {
    assert.throws(() => assertUvOutcome(before, ["iniconfig"], pyproject, "pyproject.toml"), /damaged the file/);
    const shifted = removeUvEntries(pyproject, ["iniconfig"]).replace('ruff = "2026-10-09T19:47:30Z"', 'ruff = "2026-10-09T19:47:31Z"');
    assert.throws(() => assertUvOutcome(before, ["iniconfig"], shifted, "pyproject.toml"), /damaged the file/);
  });

  test("rejects an edit that no longer parses", () => {
    const broken = pyproject.replace('ruff = "2026-10-09T19:47:30Z"', "ruff = {");
    assert.throws(() => assertUvOutcome(before, ["iniconfig"], broken, "pyproject.toml"), /no longer parses/);
  });
});

describe("lockedVersions", () => {
  const lock = `version = 1
revision = 5
requires-python = ">=3.12"

[options]
exclude-newer-span = "P7D"

[options.exclude-newer-package]
ruff = "2026-10-09T19:47:30Z"

[[package]]
name = "ruff"
version = "0.17.0"
source = { registry = "https://pypi.org/simple" }

[[package]]
name = "example"
version = "0.1.0"
source = { editable = "." }
dependencies = [
    { name = "pillow" },
]

[package.dev-dependencies]
dev = [
    { name = "ruff" },
]

[package.metadata]
requires-dist = [{ name = "pillow", specifier = "==12.3.0" }]
version = "not-a-package-version"

[[package]]
name = "pillow"
version = "12.3.0"
`;

  test("lists each package once and ignores options and sub-tables", () => {
    assert.deepEqual(lockedVersions(lock), ["example==0.1.0", "pillow==12.3.0", "ruff==0.17.0"]);
  });

  test("sees a changed version", () => {
    assert.notDeepEqual(lockedVersions(lock.replace('version = "12.3.0"', 'version = "12.2.0"')), lockedVersions(lock));
  });

  test("assertSameVersions accepts a re-lock that only dropped the option", () => {
    const relocked = lock.replace('[options.exclude-newer-package]\nruff = "2026-10-09T19:47:30Z"\n\n', "");
    assert.doesNotThrow(() => assertSameVersions(lock, relocked, ["ruff"]));
  });

  test("assertSameVersions names what moved", () => {
    const downgraded = lock.replace('version = "0.17.0"', 'version = "0.16.10"');
    assert.throws(() => assertSameVersions(lock, downgraded, ["ruff x"]),
      /removing ruff x changed locked versions \(removed ruff==0.17.0; added ruff==0.16.10\)/);
  });
});

describe("expectedLockAfterPrune", () => {
  const lock = `version = 1

[options]
exclude-newer-span = "P7D"

[options.exclude-newer-package]
ast-serialize = "2026-09-13T18:48:56Z"
iniconfig = "2026-10-06T22:48:39Z"

[[package]]
name = "iniconfig"
version = "2.3.1"
`;

  test("drops only the removed entry", () => {
    assert.equal(expectedLockAfterPrune(lock, ["ast_serialize"]), lock.replace('ast-serialize = "2026-09-13T18:48:56Z"\n', ""));
  });

  test("drops the table header and its blank line once the table is empty", () => {
    assert.equal(
      expectedLockAfterPrune(lock, ["ast-serialize", "iniconfig"]),
      'version = 1\n\n[options]\nexclude-newer-span = "P7D"\n\n[[package]]\nname = "iniconfig"\nversion = "2.3.1"\n',
    );
  });

  test("is a no-op without the table", () => {
    assert.equal(expectedLockAfterPrune("version = 1\n", ["x"]), "version = 1\n");
  });
});

describe("sandboxArgs", () => {
  const paths = {
    work: "/tmp/prune-uv-1/work", cache: "/tmp/prune-uv-1/cache", uv: "/opt/uv/uv",
    rootLinks: { "/bin": "usr/bin", "/lib64": null },
  };
  const args = sandboxArgs(paths, sandboxedUv(["lock"], "/usr/bin/python3.13"), true);
  const pairs = (flag: string, list = args) => list.flatMap((a, i) => (a === flag ? [list[i + 1]] : []));

  test("shows only /usr, the loader paths and the resolver files read-only", () => {
    assert.deepEqual(pairs("--ro-bind"), ["/usr", "/lib64", paths.uv]);
    assert.deepEqual(pairs("--symlink"), ["usr/bin"]);
    assert.deepEqual(pairs("--ro-bind-try"), ["/etc/resolv.conf", "/etc/hosts"]);
    assert.ok(!args.includes("/"), "the host root is never mounted");
  });

  test("makes only the copy and the cache writable, and clears the environment", () => {
    assert.deepEqual(pairs("--bind"), [paths.work, paths.cache]);
    assert.ok(args.includes("--clearenv") && args.includes("--unshare-all"));
    assert.deepEqual(pairs("--setenv"), ["PATH", "HOME", "UV_CACHE_DIR"]);
  });

  test("shares the network only when asked", () => {
    assert.ok(args.includes("--share-net"));
    assert.ok(!sandboxArgs(paths, ["true"], false).includes("--share-net"));
  });

  test("pins the interpreter and never builds", () => {
    assert.deepEqual(args.slice(-5), ["/tmp/bin/uv", "lock", "--no-build", "--python", "/usr/bin/python3.13"]);
  });
});

describe("assertVisible", () => {
  test("accepts an interpreter under /usr", () => {
    assert.doesNotThrow(() => assertVisible("/usr/bin/python3.13"));
    assert.doesNotThrow(() => assertVisible("/usr/local/bin/python3.12"));
  });

  test("refuses one elsewhere instead of mounting it", () => {
    assert.throws(() => assertVisible("/home/alice/bin/python"), /outside \/usr/);
    assert.throws(() => assertVisible("/usrlocal/python3"), /outside \/usr/);
  });
});

describe("PREFLIGHT", () => {
  const python = spawnSync("python3", ["-c", "import tomllib"]).status === 0 ? "python3" : null;
  const verdict = (toml: string): string => {
    const dir = mkdtempSync(path.join(tmpdir(), "wd-preflight-"));
    try {
      writeFileSync(path.join(dir, "pyproject.toml"), toml);
      const r = spawnSync(python!, ["-I", "-c", PREFLIGHT], { cwd: dir, encoding: "utf8" });
      return r.status === 0 ? "ok" : r.stderr.trim();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  const base = '[project]\nname = "x"\nversion = "1"\ndependencies = ["pillow==12.3.0"]\n';

  test("accepts a static project", { skip: !python && "needs python3 with tomllib" }, () => {
    assert.equal(verdict(`${base}\n[dependency-groups]\ndev = ["ruff==0.17.0", { include-group = "x" }]\n`), "ok");
  });

  test("refuses dynamic metadata however the key is spelled", { skip: !python && "needs python3 with tomllib" }, () => {
    assert.match(verdict('[project]\nname = "x"\n"dynamic" = ["version"]\n'), /dynamic metadata \(version\); no static version/);
    assert.match(verdict('[project]\nname = "x"\n"dyn\\u0061mic" = ["version"]\nversion = "1"\n'), /dynamic metadata/);
    assert.match(verdict('project = { name = "x", version = "1", dynamic = ["readme"] }\n'), /dynamic metadata \(readme\)/);
  });

  test("refuses sources, workspaces and direct references", { skip: !python && "needs python3 with tomllib" }, () => {
    assert.match(verdict(`${base}[tool.uv.sources]\nlib = { path = "lib" }\n`), /uv sources/);
    assert.match(verdict(`tool.uv.workspace.members = ["p/*"]\n${base}`), /a uv workspace/);
    assert.match(verdict(base.replace('"pillow==12.3.0"', '"lib @ file:///tmp/lib"')), /direct reference lib @ file/);
    assert.match(verdict(`${base}[tool.uv]\ndev-dependencies = ["x @ git+https://example.test/x"]\n`), /direct reference x @ git/);
  });

  test("refuses a file without a project table", { skip: !python && "needs python3 with tomllib" }, () => {
    assert.match(verdict('[tool.uv]\nexclude-newer = "7 days"\n'), /no \[project\] table/);
  });
});
