import test, { describe } from "node:test";
import assert from "node:assert/strict";

import { assertPruneOutcome, removeEntries, selectMatured } from "./prune.ts";
import { parseExclusions } from "./checks.ts";

/**
 * These two functions are tested together because the safety invariant in pruneRepo depends on
 * both: it removes entries, then re-parses to confirm the intended entries remain. A bug in either
 * one alone silently defeats the check.
 */

const withComments = `packages:
  - "."
minimumReleaseAge: 10080
minimumReleaseAgeExclude:
  # Already resolved into the committed lockfile before the gate was switched on.
  # Remove each entry once its version has matured.
  - "@next/env@16.2.12"
  - "@next/env@16.3.0"
  - keep@1.0.0

# an unrelated top-level comment
other: true
`;

describe("parseExclusions", () => {
  test("reads entries that follow comments", () => {
    // The original implementation required a list item on the very next line and returned nothing
    // for files shaped like this, which is how they are actually written.
    assert.deepEqual(parseExclusions(withComments), [
      "@next/env@16.2.12",
      "@next/env@16.3.0",
      "keep@1.0.0",
    ]);
  });

  test("returns nothing when the key is absent", () => {
    assert.deepEqual(parseExclusions("minimumReleaseAge: 10080\n"), []);
  });

  test("stops at the next top-level key", () => {
    const yaml = `minimumReleaseAgeExclude:\n  - a@1.0.0\nother:\n  - not-an-exclusion\n`;
    assert.deepEqual(parseExclusions(yaml), ["a@1.0.0"]);
  });

  test("strips quotes but keeps scoped names intact", () => {
    const yaml = `minimumReleaseAgeExclude:\n  - "@scope/pkg@1.2.3"\n  - plain@4.5.6\n`;
    assert.deepEqual(parseExclusions(yaml), ["@scope/pkg@1.2.3", "plain@4.5.6"]);
  });

  test("tolerates blank lines inside the block", () => {
    const yaml = `minimumReleaseAgeExclude:\n  - a@1.0.0\n\n  - b@2.0.0\n`;
    assert.deepEqual(parseExclusions(yaml), ["a@1.0.0", "b@2.0.0"]);
  });
});

describe("removeEntries", () => {
  test("removes only the named entries", () => {
    const out = removeEntries(withComments, ["@next/env@16.2.12"]);
    assert.deepEqual(parseExclusions(out), ["@next/env@16.3.0", "keep@1.0.0"]);
  });

  test("keeps the explanatory comments", () => {
    const out = removeEntries(withComments, ["@next/env@16.2.12"]);
    assert.ok(out.includes("# Remove each entry once its version has matured."));
  });

  test("does not disturb unrelated keys", () => {
    const out = removeEntries(withComments, ["@next/env@16.2.12"]);
    assert.ok(out.includes("other: true"));
    assert.ok(out.includes("minimumReleaseAge: 10080"));
    assert.ok(out.includes("# an unrelated top-level comment"));
  });

  test("removes the key entirely when the last entry goes", () => {
    // An empty key is not valid here and would read ambiguously as "no exclusions configured".
    const out = removeEntries(withComments, [
      "@next/env@16.2.12",
      "@next/env@16.3.0",
      "keep@1.0.0",
    ]);
    assert.ok(!out.includes("minimumReleaseAgeExclude"));
    assert.ok(out.includes("other: true"), "unrelated keys must survive");
  });

  test("is a no-op when nothing matches", () => {
    assert.equal(removeEntries(withComments, ["not-present@9.9.9"]), withComments);
  });

  test("is a no-op when the key is absent", () => {
    const yaml = "minimumReleaseAge: 10080\n";
    assert.equal(removeEntries(yaml, ["anything@1.0.0"]), yaml);
  });

  /**
   * The regression test for the incident. The original scanner stopped at the first comment,
   * concluded the list was empty, deleted the key and orphaned every entry. The resulting file was
   * unparseable and reached main.
   */
  test("the outcome invariant would have caught the original bug", () => {
    const buggyScanner = (yamlText: string, doomed: string[]): string => {
      const lines = yamlText.split("\n");
      const start = lines.findIndex((l) =>
        /^minimumReleaseAgeExclude:\s*$/.test(l),
      );
      let end = start + 1;
      while (end < lines.length && /^\s*-\s/.test(lines[end] ?? "")) end++;
      const kept = lines
        .slice(start + 1, end)
        .filter(
          (l) =>
            !doomed.includes(
              l.trim().slice(2).trim().replace(/^["']|["']$/g, ""),
            ),
        );
      const replacement = kept.length ? [lines[start] ?? "", ...kept] : [];
      return [
        ...lines.slice(0, start),
        ...replacement,
        ...lines.slice(end),
      ].join("\n");
    };

    const doomed = ["@next/env@16.2.12"];
    const expected = parseExclusions(withComments)
      .filter((e) => !doomed.includes(e))
      .sort();

    const damaged = parseExclusions(buggyScanner(withComments, doomed)).sort();
    assert.notDeepEqual(damaged, expected, "the invariant must reject this");

    const fixed = parseExclusions(removeEntries(withComments, doomed)).sort();
    assert.deepEqual(fixed, expected, "the fixed implementation must satisfy it");
  });
});

describe("assertPruneOutcome", () => {
  const before = ["a@1.0.0", "b@2.0.0", "c@3.0.0"];

  test("accepts an edit that removed exactly what was intended", () => {
    const edited = `minimumReleaseAgeExclude:\n  - b@2.0.0\n  - c@3.0.0\n`;
    assert.doesNotThrow(() => assertPruneOutcome(before, ["a@1.0.0"], edited));
  });

  test("accepts removing everything, which drops the key", () => {
    assert.doesNotThrow(() => assertPruneOutcome(before, before, "other: true\n"));
  });

  test("rejects an edit that lost entries it should have kept", () => {
    // The incident in one line: the key vanished and every entry went with it.
    assert.throws(
      () => assertPruneOutcome(before, ["a@1.0.0"], "other: true\n"),
      /expected 2 entries to remain .* but the edited file parses as 0/,
    );
  });

  test("rejects an edit that kept an entry it should have removed", () => {
    const edited = `minimumReleaseAgeExclude:\n  - a@1.0.0\n  - b@2.0.0\n  - c@3.0.0\n`;
    assert.throws(() => assertPruneOutcome(before, ["a@1.0.0"], edited), /damaged the file/);
  });

  test("names the file so the error points somewhere", () => {
    assert.throws(
      () => assertPruneOutcome(before, [], "other: true\n", "frontend/pnpm-workspace.yaml"),
      /refusing to write frontend\/pnpm-workspace.yaml/,
    );
  });
});

describe("selectMatured", () => {
  const DAY = 86_400_000;
  const now = 1_000 * DAY;
  const cutoff = 7 * DAY;

  test("selects entries older than the cutoff", async () => {
    const out = await selectMatured(["old@1.0.0"], cutoff, async () => now - 30 * DAY, now);
    assert.deepEqual(out, ["old@1.0.0"]);
  });

  test("leaves entries younger than the cutoff", async () => {
    const out = await selectMatured(["young@1.0.0"], cutoff, async () => now - DAY, now);
    assert.deepEqual(out, []);
  });

  test("leaves entries whose age cannot be determined", async () => {
    // Removing one could un-exempt a version that is still young and break installs for everyone.
    const out = await selectMatured(["mystery@1.0.0"], cutoff, async () => null, now);
    assert.deepEqual(out, []);
  });

  test("treats exactly the cutoff as matured", async () => {
    const out = await selectMatured(["edge@1.0.0"], cutoff, async () => now - cutoff, now);
    assert.deepEqual(out, ["edge@1.0.0"]);
  });

  test("sorts nothing and preserves input order", async () => {
    const ages: Record<string, number> = { "b@1.0.0": now - 30 * DAY, "a@1.0.0": now - 30 * DAY };
    const out = await selectMatured(["b@1.0.0", "a@1.0.0"], cutoff, async (e) => ages[e] ?? null, now);
    assert.deepEqual(out, ["b@1.0.0", "a@1.0.0"]);
  });
});

describe("the changed-file guard's path handling", () => {
  /**
   * The guard once parsed `git status --porcelain` by column offset, taking everything from index
   * 3. That is correct for a raw status line, but the git helper trims its output, and trimming
   * removes the leading space of an unstaged change. The path then started one character late, so
   * a correct edit was rejected as "unexpected changes beyond pnpm-workspace.yaml:
   * npm-workspace.yaml" and the prune could never push.
   */
  const sliceByOffset = (line: string) => line.trim().slice(3).trim();
  const barePaths = (out: string) => out.split("\n").map((l) => l.trim()).filter(Boolean);

  test("the old offset parsing loses the first character once the line is trimmed", () => {
    assert.equal(sliceByOffset(" M pnpm-workspace.yaml"), "npm-workspace.yaml");
    assert.equal(sliceByOffset(" M frontend/pnpm-workspace.yaml"), "rontend/pnpm-workspace.yaml");
  });

  test("bare path listings are unaffected by trimming", () => {
    assert.deepEqual(barePaths("pnpm-workspace.yaml\n"), ["pnpm-workspace.yaml"]);
    assert.deepEqual(barePaths("  frontend/pnpm-workspace.yaml  \n"), ["frontend/pnpm-workspace.yaml"]);
  });

  test("an unrelated file is still detected as unexpected", () => {
    // The guard must keep working, not merely stop misfiring.
    const changed = barePaths("pnpm-workspace.yaml\nnode_modules/.modules.yaml\n");
    assert.deepEqual(changed.filter((f) => f !== "pnpm-workspace.yaml"), ["node_modules/.modules.yaml"]);
  });

  test("an edit confined to the expected file leaves nothing unexpected", () => {
    const changed = barePaths("frontend/pnpm-workspace.yaml\n");
    assert.deepEqual(changed.filter((f) => f !== "frontend/pnpm-workspace.yaml"), []);
  });
});
