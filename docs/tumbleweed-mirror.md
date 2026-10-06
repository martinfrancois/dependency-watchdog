# Tumbleweed mirror

`.github/workflows/tumbleweed-mirror.yml` copies every openSUSE Tumbleweed container snapshot from
`registry.opensuse.org/opensuse/tumbleweed` to `ghcr.io/martinfrancois/tumbleweed`, unchanged, on
the day it appears. This page records why the mirror exists, what it does, and when it can go.

It lives in this repository because the mirror serves the same dependency policy the watchdog
reports on, and because this repository is public, so its Actions minutes are unlimited.

## The constraints

1. **Every dependency waits 7 days.** Renovate's `minimumReleaseAge` is 7 days with
   `minimumReleaseAgeBehaviour: timestamp-required` on every repository this watchdog covers, and
   the policy has no exemptions. A dependency without a release date never updates.
2. **The Dockerfile pins one exact snapshot**, as `tumbleweed:<date>@sha256:<digest>`. The digest
   makes builds reproducible. The date tag lets Renovate see that a newer snapshot exists and date it.
3. **It has to be Tumbleweed.** The container is a development and test environment for software
   that runs on openSUSE MicroOS, and MicroOS is built from Tumbleweed snapshots. Another
   distribution would test a different userland.

## What breaks them

registry.opensuse.org keeps x86_64 (amd64) Tumbleweed snapshots for about 7 to 8 days. Other
architectures stay longer. The tag list on 2026-10-06:

| Date tags | Architectures still in the index |
| --- | --- |
| 20260718 to 20260912 | ppc64le or riscv64 only |
| 20260918 to 20260928 | s390x, plus arm and arm64 on some dates |
| 20260929 to 20261003 | amd64 present, with 386, arm and arm64 on some dates |

So on 2026-10-06 the oldest amd64 snapshot was 20260929, 7 days old, and everything older had
lost its amd64 image. A container that had pinned a September digest failed to build with
`manifest unknown`, because the registry had already deleted it.

Put the two numbers next to each other. A snapshot becomes eligible under the policy on day 7 and
is deleted on day 7 or 8. Renovate would have to open, test and merge the update inside that
one-day gap, and the next build after that would still fail a week later unless the pin moved
again on time.

## Why a shorter wait does not help

With a 6-day wait, or none, the pinned snapshot is still deleted about a week after it was built.
The build then breaks unless the pin is renewed at least once a week and the renewal is merged
before the deletion. Renovate runs on the private repositories once a week, on Fridays, so one
skipped or failing Friday breaks the build. The wait is not the problem. The deletion is.

## Alternatives considered

| Option | Why not |
| --- | --- |
| Docker Hub `opensuse/tumbleweed` | Only `latest`, overwritten several times a day. No dated tags, no history to pin. |
| openSUSE Slowroll | No container image on registry.opensuse.org or Docker Hub. |
| MicroOS images | Same registry, same deletion. |
| `opensuse/toolbox` | Built on Tumbleweed, but tagged by toolbox build (`16.3-11.622`), not by snapshot date, and on the same registry: on 2026-10-06 the oldest toolbox build with an amd64 image was built on snapshot 20260929, the same retention. |
| Leap | Pinnable and long-lived, but too far from MicroOS to test it. |
| Exempt the image from the 7-day wait | Against the policy, and the pin would still break a week later. |
| Build our own image in the Open Build Service | More work to maintain, and OBS keeps only the latest build, so the same deletion problem returns. |

## The decision

Mirror every snapshot unchanged to `ghcr.io/martinfrancois/tumbleweed:<date>`, on the day it
appears, and keep 60 days of them. `crane copy` copies by digest, so the mirrored index and every
per-architecture manifest keep the digests they have upstream; the job checks this after each copy
and fails when they differ. Renovate reads the release date of each mirrored tag from GitHub's
container package API (`created_at`), so the 7-day wait applies to this image like to every other
dependency, and a snapshot stays pullable for about 53 days after it becomes eligible.

The cost is one daily workflow here, using `GITHUB_TOKEN` and no other secret, and the GHCR storage,
which GitHub does not bill for public packages.

## How the job decides

- **Which tags.** Only `YYYYMMDD` tags, not the build tags (`20261003.37.215`) or `latest`. A date
  tag is copied once its index contains a linux/amd64 image. Dates that only ever carry other
  architectures are skipped, since registry.opensuse.org drops amd64 first and an amd64 pin has no
  use for them.
- **Copied tags never change.** A tag already in the mirror is skipped, even if openSUSE later adds
  an architecture to that date's index. The digest a consumer pinned stays valid.
- **Retention.** Tags whose date is more than 60 days before the newest mirrored date are deleted,
  together with the per-architecture manifests no remaining index refers to. The window counts back
  from the newest snapshot, not from today, so if openSUSE stops publishing, the mirror keeps its
  last 60 days instead of emptying itself.
- **Only the last 14 days are checked for new tags.** amd64 is gone after 7 to 8 days, so an
  older tag that was never copied can never qualify, and checking it again every day only costs
  requests to registry.opensuse.org. Each tag costs one request: the digest is the SHA-256 of the
  manifest bytes.
- **Pins in other repositories are not checked.** The repositories that pin the mirror are private,
  and reading them would need a token with more access than `GITHUB_TOKEN`. Renovate moves those
  pins weekly, so a pin is normally at most two weeks old. A pin older than 60 days means its
  Renovate updates have been stuck for about seven weeks.
- **If the workflow stops**, for example because Actions is down, nothing already mirrored is
  deleted, since the retention runs in the same job. Renovate stops seeing new snapshots and the
  existing pins keep building. That is why this can run on GitHub Actions, unlike the watchdog.
- **A pull request only plans.** The `plan` job runs `--dry-run` with read permissions and prints
  what a real run would copy and delete. Only the scheduled or manually started `mirror` job has
  `packages: write`.

## One-time setup

The first scheduled or manual run creates the package. GitHub gives a package created by a
workflow the visibility of the repository that ran it, and admin access for that repository, which
is what lets `GITHUB_TOKEN` delete old versions. Check it once after the first run:

```bash
docker logout ghcr.io
docker pull ghcr.io/martinfrancois/tumbleweed:<a mirrored date>
```

If the pull is refused, open the package settings on GitHub, use **Change visibility**, and choose
**Public**. GitHub has no API for this step, and a public package cannot be made private again.
Renovate's lookup and anonymous pulls both need the package to be public.

## Testing a change

```bash
pnpm test                                                           # plan and retention logic
GITHUB_REPOSITORY_OWNER=martinfrancois node src/cli-tumbleweed-mirror.ts --dry-run
```

The dry run needs `crane` and an authenticated `gh` on `PATH`, reads both registries, and writes
nothing.

## When to revisit

Remove the mirror and pin registry.opensuse.org directly again if either becomes true:

- registry.opensuse.org keeps amd64 Tumbleweed snapshots for longer than the 7-day wait plus a
  margin of a few weeks. Check the tag list: the oldest date tag whose index still has amd64 is the
  current retention.
- openSUSE publishes dated, retained Tumbleweed images somewhere else, for example on Docker Hub.
