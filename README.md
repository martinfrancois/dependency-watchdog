# dependency-watchdog

Scheduled jobs that tell you when your Renovate automation has stopped working, and keep its
release-age exclusion lists from silently becoming permanent. Optional Codex recovery investigates
incidents and prepares tested repairs.

- **watchdog** reports persistent findings and sends weekly reminders. Inspect its run report to check coverage.
- **prune** proposes a PR removing `minimumReleaseAgeExclude` entries whose version has aged past the cooldown.
- **recovery** calls an installed Codex CLI to investigate confirmed incidents. See [Codex recovery](docs/recovery.md).

No dependencies. Node's standard library, `git` and the GitHub CLI, nothing else. A watchdog that
can be broken by a dependency update would be an unusually stupid way for this to fail.

## Who this is for

You have several repositories on Renovate with `lockFileMaintenance` and a release-age cooldown
(`minimumReleaseAge` in pnpm, or Renovate's own), you automerge routine updates, and you do not read
every pull request. The failure mode you are worried about is not a bad update, it is the automation
quietly stopping and nobody noticing for a month.

If you read every dependency pull request as it arrives, you do not need this.

## Why not a GitHub Action

A monitor hosted on the thing it monitors shares its failure modes. Actions billing lapsed on the
repositories this was built for, every workflow stopped, and an Actions-hosted watchdog would have
gone quiet at exactly the moment it was needed. Quiet is indistinguishable from healthy.

Running it elsewhere moves the single point of failure to that machine, which is why
[healthchecks.io](https://healthchecks.io) is not optional here. It is the only component that is
neither on your server nor on GitHub, so it is the only one that can report that both have stopped.

## Install

```bash
git clone https://github.com/martinfrancois/dependency-watchdog.git
cd dependency-watchdog
```

The checkout can live anywhere; `install.sh` substitutes its own path into the systemd units.

### 1. Prerequisites

```bash
node --version    # 24 or newer
gh auth status    # scopes: repo, workflow
```

Node 24 is required, not merely recommended: the sources are TypeScript and are run directly by
node's type stripping, with no build step and no compiler at runtime. There is nothing to transpile
and nothing in `node_modules` that runs in production.

The jobs authenticate through `gh` rather than a token you paste somewhere, so there is no
long-lived secret in this repository and nothing to rotate. If that auth lapses, every API call
throws, the run aborts before pinging healthchecks.io, and the dead man's switch fires. That is
intended: a blind watchdog must not look healthy.

### 2. Settings

```bash
export DEP_WATCHDOG_CONFIG_DIR=~/.config/dep-watchdog
mkdir -p ~/.config/dep-watchdog
cp config.example.json ~/.config/dep-watchdog/config.json
$EDITOR ~/.config/dep-watchdog/config.json
```

The jobs read the directory from that variable only and refuse to start without it. `install.sh`
writes it into the units, defaulting to the path above.

Only `repos` is required. Repositories are listed rather than discovered from an account, so that a
rename or transfer surfaces as a failing lookup instead of silently dropping out of coverage.

For monorepos, point `workspaceFiles` at wherever the pnpm settings actually live. Set `commitName`
and `commitEmail` before enabling the prune; it refuses to push without them rather than attributing
automated commits to whatever identity happens to be on the machine.

### 3. Telegram

1. Message [@BotFather](https://t.me/BotFather), send `/newbot`, follow the prompts, copy the token.
2. **Send your new bot a message.** Telegram will not reveal a chat to a bot nobody has spoken to,
   so the installer cannot resolve the chat id until you do.

### 4. healthchecks.io

1. Create a check. **Period 1 day, grace 6 hours**, which tolerates the randomised timer delay and a
   single missed run without crying wolf.
2. Set its integration to **Telegram, not email**. The one alert that means "your monitoring is
   dead" must not arrive in a mailbox you do not read.
3. Copy the ping URL.

### 5. Secrets

```bash
cp config.env.example ~/.config/dep-watchdog/config.env
chmod 600 ~/.config/dep-watchdog/config.env
$EDITOR ~/.config/dep-watchdog/config.env
```

Leave `TELEGRAM_CHAT_ID=AUTO`. Environment variables of the same names take precedence, if you would
rather inject them.

### 6. Run it

```bash
./install.sh                    # both jobs
ENABLE_PRUNE=0 ./install.sh     # watchdog only, prune left disabled
```

It refuses while anything is still `PLACEHOLDER`, resolves the chat id, dry runs, installs the
units, enables linger so the timers survive logout and reboot, and starts them.

### 7. Verify the part everyone skips

```bash
systemctl --user stop dep-watchdog.timer
# wait past the healthchecks.io period plus grace; confirm it alerts you
systemctl --user start dep-watchdog.timer
```

An untested dead man's switch is decoration.

## What it reports

Five checks run against each configured repository.

| Condition | Default threshold |
| --- | --- |
| A Renovate security PR remains open | 48 hours since opening |
| A Renovate PR currently has failing checks | 7 days since opening |
| A lockfile maintenance PR remains open | 15 days since opening |
| Matured exclusions remain after the weekly prune had time to run | 7 days since first observation |
| The failing default-branch history includes a dependency commit | Two consecutive observations |

PR age is not continuous failure duration. A 15-day-old PR that first failed yesterday is still
15 days old. Alerts state the PR age and include the current head SHA and failing checks.

A finding must appear on two consecutive observations before notification. The watchdog sends a
new Telegram message every `escalateAfterDays` while it remains open, seven days by default. These
are separate messages, not replies in a Telegram thread. Ordinary scans send no all-clear messages.
When recovery is enabled, investigation and review messages are yellow; blocked repairs are red.

Security findings take precedence over ordinary failing-PR findings. An old maintenance PR with
failing checks uses the failing-PR alert once its threshold is reached. This avoids two alerts for
the same blocker.

The default-branch check reads the repository's actual default branch, including repositories with
strict merge rules. A dependency commit in failing history does not prove that it caused the
failure. Post-merge jobs, policy checks, and audit failures also appear here. A passing current head
ends the finding. A head without check results has unknown health, recorded in the report.

## What the watched repositories need

### The security check needs a label

```json
{
  "vulnerabilityAlerts": {
    "labels": ["security"]
  }
}
```

Renovate does not label vulnerability-driven pull requests unless you ask it to. Without this,
security pull requests are indistinguishable from ordinary ones and the check never fires. Use a
different label if you prefer, and set `securityLabels` in `config.json` to match.

Matching on the title instead is not an option: doing so matched nineteen unrelated pull requests
during development, which is why both the label and Renovate authorship are required.

### Lockfile maintenance

```json
{
  "lockFileMaintenance": {
    "enabled": true,
    "schedule": ["* 0-3 * * 1"]
  }
}
```

The watchdog reports overdue open maintenance PRs. It does not infer a stopped job from absent
commits. A refresh has no commit to make when resolution produces no changes, and ordinary updates
also change lockfiles. Searching a fixed number of commit titles cannot establish scheduler health.
The report records the open PRs and whether a lockfile exists.

The setting names `checks.lockfileRefresh` and `thresholds.noRefreshDays` remain compatible with
existing configurations. The latter now limits the age of an open maintenance PR.

This leaves a coverage limit: detecting a Renovate job that stops before producing any PR needs a
separate heartbeat or Renovate execution logs. The GitHub evidence collected here does not prove
that every scheduled refresh ran. See [Renovate's maintenance configuration](https://docs.renovatebot.com/configuration-options/#lockfilemaintenance).

### The exclusion check needs the pnpm cooldown

```yaml
# pnpm-workspace.yaml
minimumReleaseAge: 10080          # 7 days, in minutes
minimumReleaseAgeExclude:
  - "@next/env@16.3.0"
```

Only relevant if you run the package-manager-level cooldown as well as Renovate's. The two are not
redundant: Renovate's `minimumReleaseAge` governs what it proposes, while pnpm's governs what any
install may resolve, including one a person runs by hand. The second is what makes a typo'd manual
`pnpm add` safe.

The exclude list is the escape hatch for the case that motivates it: a critical fix published an
hour ago, which the cooldown would otherwise block for a week. Adding the exact version there lets
that one install through and leaves the gate closed for everything else. Those entries are meant to
be temporary, and forgetting to remove them is exactly what this project watches for.

The matching Renovate side, so the two agree rather than fighting:

```json
{
  "minimumReleaseAge": "7 days",
  "minimumReleaseAgeBehaviour": "timestamp-required",
  "internalChecksFilter": "strict"
}
```

`timestamp-required` refuses to age a release whose publish time cannot be established, rather than
assuming the best. `strict` stops Renovate raising a pull request that pnpm would then refuse to
install, which otherwise produces a queue of pull requests that cannot go green.

### The failing-pull-request check needs nothing

It reads check runs and commit statuses, which exist regardless of configuration.

## What the prune does

Proposes a PR removing `minimumReleaseAgeExclude` entries whose version is older than the cooldown.
It validates the edited workspace, checks that no other files changed, and reuses an open prune PR
for the same entries. It respects Git hooks and leaves merging to the operator.

It is a job rather than a CI check on purpose. A check that fails when an entry turns eight days old
is triggered by the passage of time, not by a change. It would go red on an unrelated commit and,
being required, block whatever is behind it, including your next security pull request. A guard whose
failure mode is "delay security fixes" is worse than the drift it prevents.

### Why it has four guards

An early version of this script emptied `main` in two repositories. Its block scanner stopped at the
first comment line, concluded the exclusion list was empty, deleted the key and orphaned every entry;
the unparseable result went straight to `main`. The attempted revert then ran in a shallow clone,
where `git revert` has no parent to diff against, and deleted the entire tree.

Nothing between "edit the text" and "git push" had looked at the result. All four guards close that
gap:

1. **Outcome invariant.** The edited file is re-parsed and the entries that should remain must
   remain. This is the check that catches the original bug, and structural damage generally rather
   than one anticipated shape of it.
2. **pnpm must accept the file.** `pnpm install --lockfile-only` runs against the edit; if pnpm
   rejects it, the original is restored and nothing is pushed.
3. **Only the expected file may change.** A touched lockfile would mean the edit altered resolution,
   which removing a matured entry must never do.
4. **`main()` runs only as the process entry**, so importing a module for a test cannot perform a
   live push. That is how the incident reached production.

If you ever need to undo a bad push: restore with `git checkout <last-good-sha> -- .` and commit.
That is additive and needs no force push. Never `git revert` in a shallow clone.

## Operating

```bash
systemctl --user list-timers 'dep-*'
journalctl --user -u dep-watchdog.service -n 100 -o cat
journalctl --user -u dep-prune.service -n 100 -o cat
node src/cli-watchdog.ts --dry-run
node src/cli-watchdog.ts --json > /var/tmp/watchdog-report.json
node src/cli-prune.ts --dry-run
```

Set `DEP_WATCHDOG_CONFIG_DIR` in the shell first, as in step 2.

Both watchdog inspection modes are read-only, including on failure. They send no Telegram messages
or healthchecks pings and write no state. Text output includes every finding, including suppressed
ones. JSON includes all configured checks, their evidence, durations, failures, disabled checks,
notification decisions, next reminder dates, run ID, source digest, and effective settings.

`complete: true` means the enabled checks completed without an observation error. It does not mean
all repositories passed CI. Check the findings and each check's evidence and assessment.

Normal scheduled runs save these files under `$XDG_STATE_HOME/dep-watchdog`, defaulting to
`~/.local/state/dep-watchdog`:

- `state.json` tracks confirmation and notification times. Writes use an atomic rename. Corrupt
  state produces a `state_reset` journal event before starting fresh.
- `last-run.json` contains the latest watchdog inspection and delivery acknowledgements.
- `last-prune.json` contains the most recent prune results per repository, including errors.

The journal also receives JSON `check`, `finding`, and `run` events. Search by the finding ID in an
alert to recover the evidence and reason for sending it. Journal retention follows the server's
journald configuration. The latest report files replace their previous versions.

API errors remain errors. A failed lookup preserves confirmed incidents and discards unconfirmed
sightings so a later observation must be confirmed again. It does not report those incidents as
resolved. Delivery saves state after each successful message, so a later send failure leaves only
unsent messages due for retry. A process crash after Telegram accepts a message but before the state
write still permits a duplicate; Telegram sendMessage does not provide an idempotency key here.

Only the daily watchdog acknowledges its healthchecks.io heartbeat. The weekly prune must not
clear a failed watchdog heartbeat. Inspect the prune timer and `last-prune.json` when exclusion
findings persist. `thresholds.exclusionGraceDays` defaults to seven days for the weekly timer; change
it when changing the prune schedule.

## Limitations

- **pnpm only.** The exclusion logic reads `minimumReleaseAgeExclude` from `pnpm-workspace.yaml`.
  npm's `min-release-age` and bun's `minimumReleaseAge` have no equivalent list, so the prune has
  nothing to do there. The other four checks work regardless of package manager.
- **Telegram only.** The notifier is one small module; adding another channel means implementing one
  function.
- **GitHub only**, through `gh`.
- **systemd user units.** On other init systems the scripts run fine from any scheduler; only
  `install.sh` is systemd-specific.

## Licence

MIT.
