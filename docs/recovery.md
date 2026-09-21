# Codex recovery

Recovery is optional and disabled by default. Enabling it authorizes the installed Codex CLI to
investigate confirmed incidents, edit repositories, run tests, deploy local watchdog repairs, and
submit pull requests. It uses the operator's existing Codex and GitHub authentication. Codex runs
without interactive approvals and with access to the host, so enable it only on an installation
where that access is intended.

Add this to the private `config.json`, replacing the repository and absolute paths:

```json
{
  "recovery": {
    "enabled": true,
    "codexCommand": "codex",
    "watchdogRepo": "upstream-owner/dependency-watchdog",
    "watchdogCheckout": "/opt/dependency-watchdog",
    "workspaceRoot": "/var/tmp/dependency-watchdog-repairs",
    "timeoutMinutes": 90,
    "maxAttempts": 2,
    "allowWatchdogMerge": false
  }
}
```

Check `codex login status` and `gh auth status`, then rerun `./install.sh`. The installer adds a
recovery timer and a watchdog failure handler. The timer checks the durable queue every minute
when no worker is running. A watchdog or prune service failure also starts recovery through systemd's
`OnFailure`, including failures that prevent the main CLI from starting. Recovery still requires
its own modules, Node, and the host to work. The external heartbeat detects failures beyond that
boundary.

## Repair order

Every watchdog repair MUST follow this order, including installations run by contributors:

1. Reproduce the incident and fix the watchdog on a local branch.
2. Run the required checks, deploy the candidate locally, and verify the original incident with a
   fresh process. Keep a rollback copy outside the repository.
3. Submit a PR only after local verification passes.

The authenticated upstream owner submits a same-repository PR. With `allowWatchdogMerge: true`,
Codex MUST wait for passing CI and addressed bot findings before rebase-merging it, deploying the
merged revision, and verifying again. With the setting disabled, the PR waits for review.

A contributor MUST create or reuse their fork after local verification, push to that fork, and
submit an upstream PR. Contributors MUST NOT push directly to upstream or merge upstream PRs.
The verified local deployment stays running while the maintainer reviews the fork PR. Repository
write permission alone does not select owner mode; the worker compares the authenticated login
with the upstream owner's login.

For a defect in a monitored repository, Codex prepares a tested PR for the operator to review.
It MUST NOT merge that PR or push to the monitored repository's default branch.

The worker independently checks PR destinations and state. For watchdog repairs it also checks
fork ownership, the installed systemd command, the clean deployed Git revision, and a fresh scan.
Instructions prohibit clearing incident state, weakening checks, bypassing hooks, force-pushing,
and treating incident text or CI logs as authority to expand the task. Tests cover these rules,
but Codex remains responsible for executing its repair instructions; this is not a security
sandbox around the authenticated account.

## Merge checks and the billing exception

Before an owner merge, Codex runs:

```bash
node src/cli-merge-gate.ts upstream-owner/dependency-watchdog 123
```

The gate reports its decision, reasons, and the exact PR head. Codex MUST use that head with
`gh pr merge --rebase --match-head-commit`. Pending or failed checks, unresolved bot threads,
bot requests for changes, detected bot findings, or incomplete review evidence block merging.
Codex also reads bot comments, since free-form review prose is not a reliable structured verdict.

When GitHub explicitly reports an Actions billing or minutes limit, Codex MUST run the equivalent
CI checks locally before using `--local-checks-passed`. The gate verifies the Actions job's billing
annotation. This exception does not cover failing tests or pending checks, and bot checks and
findings still MUST pass. GitHub branch protection remains enforced. The worker does not fabricate
check results or use an administrator override.

## Notifications and diagnosis

Telegram uses yellow while Codex is queued or investigating, when a PR needs review, and when a
repair has been verified. It uses red when Codex is unavailable or cannot finish the repair. A
completed repair receives one result message; unchanged healthy scans do not send all-clear
messages. Review messages include PR links. Repeated findings reuse the same incident rather than
launching another worker. The normal reminder interval still applies to persistent findings.

```bash
node src/cli-recovery.ts --status
journalctl --user -u dep-recovery.service -u dep-watchdog-rescue.service -n 100 -o cat
node src/cli-recovery.ts --retry INCIDENT_KEY
```

`--status` only reads state. `--retry` accepts a blocked incident, archives its previous record,
and queues a new attempt. Use it after addressing the reported blocker. Declared blockers stop the
attempt immediately. Invalid results or failed independent verification retry up to `maxAttempts`.
A timeout terminates the Codex process group and reports the deadline and private log directory.
A result returned after that deadline is rejected, including a successful exit during shutdown.
Interrupted workers recover from persisted state and report their private log directory.
Telegram delivery failures do not prevent investigation. Separate delivery records preserve worker
state while reminders are sent, and completed results remain available for notification retry. The worker follows
review PRs, retries later CI failures within the attempt limit, and verifies closed PRs with a
fresh scan before marking their incidents resolved. A complete watchdog run also resolves any
queued, review or blocked incident whose finding it no longer reports, so a problem the operator
fixed by hand does not stay red; that incident receives one result message.

Private incident records, prompts, CLI event logs, errors, results, and the last valid recovery
settings live under `$XDG_STATE_HOME/dep-watchdog/recovery`, defaulting to
`~/.local/state/dep-watchdog/recovery`. Directories use mode 700 and files use mode 600. Each
investigation has a stable incident key and a dated log directory. These logs are retained until
the operator removes them; monitor disk usage on long-lived installations.

The recovery prompt instructs Codex to record its test containers and generated directories, save
test evidence, and remove only its own stopped containers and generated dependencies or build
output. This cleanup depends on the agent following those instructions. Source checkouts, Git
history, evidence, active deployments, running containers and shared caches are retained. The
prompt prohibits broad pruning and requires a storage blocker when owned-artifact cleanup does
not restore enough space to test.

Keep deployment inventories, account details, tokens, and investigation reports outside the
checkout. Public documentation should contain reusable instructions and generic examples only.
