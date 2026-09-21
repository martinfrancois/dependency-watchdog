# Working on this repository

Instructions for coding agents, and for anyone else who finds them useful. Most of these exist
because something went wrong once; the reason is recorded so the rule is not followed blindly.

## Treat this project as open source now

Agents MUST treat this repository as public open-source software, even while its GitHub visibility
is private and before its first public release. Code, documentation, examples, test fixtures, agent
instructions, commit messages, issues and pull requests MUST be safe to publish. Private repository
visibility is not an exception.

Use generic examples and operator-supplied configuration for installation-specific settings.
Credentials, private hostnames and IP addresses, homelab topology, actual installation paths,
private account or repository inventories, Telegram identifiers, and unredacted logs or incident
reports MUST stay outside repository files, Git history and GitHub discussions or attachments.
Keep operational records in private local storage outside the checkout.

Before committing or posting GitHub text, inspect the exact staged diff or outgoing content for
installation-specific details. Replace them with generic placeholders or move the private record
outside the repository before proceeding. Write setup and recovery instructions for an independent
operator, without assuming access to the maintainer's infrastructure.

### The check to run before every commit and every PR or issue text

Pushed history is permanent. This repository was already republished once with a single fresh
commit because its early history carried the operator's repository list, a hostname and an
incident report. A follow-up commit does not undo such a leak; only history removal does, so a
slip is a stop-and-tell-the-operator event, not something to patch quietly.

Run this from the checkout with the change staged, and read every hit before deciding it is fine:

```bash
git diff --cached | grep -n -E "/home/|/var/lib/|/opt/[a-z]|$(hostname)|[0-9]{9,}|hc-ping|api\.telegram"
cfg="${XDG_CONFIG_HOME:-$HOME/.config}/dep-watchdog/config.json"
git diff --cached | grep -n -F -f <(node -p 'require(process.argv[1]).repos.join("\n")' "$cfg" | grep -v -F "$(git remote get-url origin | sed -E 's#.*github.com[:/]##; s#\.git$##')")
```

The first line catches absolute paths, the host name, chat or run identifiers, and notifier URLs.
The second catches every repository the private config monitors, except this one. Run the same
two greps over the text of a PR description, issue or review comment before posting it. Fixtures
use `o/r`, `owner/repo` and `example.test`; unit files use `__REPO_DIR__`; documentation uses
the placeholders in `config.example.json`. Anything that only makes sense on the maintainer's
machine belongs under `~/.local/state/dep-watchdog/`, never in the tree.

## Rules specific to this repository

### Never push a generated file you have not parsed

Anything here that edits a file and pushes must re-parse its own output and assert the intended
outcome before committing. Not "does it look right", but a positive check: the entries that should
remain, do remain.

This exists because an early version of `prune.ts` emptied `main` in two repositories. Its block
scanner stopped at the first comment line, concluded the exclusion list was empty, deleted the key
and orphaned every entry. The unparseable result went straight to `main` because nothing between
"edit the text" and "git push" ever looked at the result.

Where a real tool can validate the file, use it rather than a second parser of your own. For pnpm
settings that means running `pnpm install --lockfile-only` and aborting if pnpm rejects the file.

### Keep entry points separate from logic

`src/cli-*.ts` are the only files that do anything on import. They contain wiring and nothing else;
every decision lives in a module that exports functions and runs nothing.

This exists because of the incident above. Originally `main()` sat in the same file as the logic,
guarded by an entry-point check. A test imported the module to exercise one exported function, the
guard was absent from that particular file, and the job ran for real and pushed. A guard you must
remember to add is a guard you will eventually forget; a file with no top-level effects cannot have
the problem at all.

The consequence for coverage: `src/cli-*.ts` are excluded from the thresholds. That exclusion is
only honest while those files stay free of decisions. If you find yourself adding an `if` to one,
move it into a module and test it there.

### Never run history operations in a shallow clone

`git revert`, `rebase` and `cherry-pick` need history that a `--depth 1` clone does not have.
Reverting in a shallow clone produced a diff against nothing and deleted an entire repository tree.

Shallow clones are for reading files. Clone fully for anything that reads history.

To undo a bad push, prefer `git checkout <last-good-sha> -- .` followed by a normal commit. It is
additive, needs no force push, and leaves the record intact. Force-pushing to erase history is a
decision for the repository owner, not a cleanup step to take unilaterally.

### Adding a check is a cost, not a feature

Every condition the watchdog reports must survive one question: would someone get up and act on
this? If the honest answer is "probably fine", it does not go in. A channel that speaks when things
are fine teaches people to ignore it, and then it is worse than nothing, because its silence still
reads as reassurance.

New checks need the same protections as the existing ones: two runs before speaking, deduplication
by a stable id, and no all-clear messages.

Watch for the noise this catches. Matching pull request titles for words like "vulnerability"
matched nineteen unrelated pull requests during development. Requiring both the label and Renovate
authorship reduced it to zero false positives.

### No dependencies

Standard library only, at runtime and in the tests. A watchdog broken by a dependency update would
be an unusually stupid way for this to fail. If something seems to need a package, it probably needs
less code instead.

The sources are TypeScript, run directly by node's type stripping. `typescript` and `@types/node`
are devDependencies used for `tsc --noEmit` and nothing else: there is no build output, and no
compiler involved in running the jobs. Tests use `node:test` for the same reason.

### Inject what you cannot control

Anything that touches the network, the filesystem or another process is passed in rather than
imported, so the logic around it can be tested without either mocking the module system or reaching
a real repository. `checks.ts` takes a `Deps`, `github.ts` takes a `Runner`, `selectMatured` takes
its clock and its lookup. Follow the same shape when adding code; a function that reaches out to the
world directly is one that will be tested by nobody.

### Verify against reality, not against your model of it

Claims in comments and commit messages here are measured, not assumed. If you write that something
is faster, include the numbers and how they were taken. If you write that a setting has a given
default, quote the source. Where a behaviour matters, add a negative control: prove the check fails
when the thing it guards is broken, rather than only that it passes today.

## Maintainer preferences

These are conventions rather than correctness, but follow them.

- **No em dashes**, in code, comments, commit messages, documentation or pull request text.
- **Conventional commits**, and commit bodies that explain why rather than restating the diff.
- **No `Co-authored-by` trailers.** Exception: a project whose contribution policy requires an AI
  disclosure trailer, in which case follow that project's exact format.
- **Rebase merges**, not squash.
- Do not add agent metafiles (`.claude/`, `.cursor/`) to commits.

## Testing changes here

```bash
npm test                          # unit tests, fails below 80% lines, branches and functions
npm run typecheck                 # tsc --noEmit, strict
node src/cli-watchdog.ts --dry-run   # reports, notifies nothing, writes no state
node src/cli-prune.ts --dry-run      # reports, touches no repository
```

The coverage thresholds are enforced by node itself rather than a reporter, so there is no second
tool to keep in step and no way to pass locally while failing in CI. If a change puts you under the
threshold, the fix is a test for the logic, not a wider exclusion. The one place that judgement was
already exercised is recorded above.

Both dry runs are safe against real repositories and are the fastest way to check a change. Use a
throwaway config to test against repositories you do not own:

```bash
DEP_WATCHDOG_CONFIG_DIR=/tmp/test-cfg node src/cli-watchdog.ts --dry-run
```

Before changing anything that writes: confirm the outcome invariant in `pruneRepo` still fails when
given a deliberately broken edit. A guard that cannot fail is not a guard.
