import test, { describe } from "node:test";
import assert from "node:assert/strict";

import {
  assertSameVersions, assertUvOutcome, isUvSettingsFile, lockedVersions, maturedUvEntries, parseSpan, parseUvExclusions,
  removeUvEntries, uvCooldownMs,
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
