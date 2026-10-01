---
status: in-progress
size: medium
---

# CI, the copies and the MCP guide survive the move to iterate/private

Misha decided on 2026-10-01: iterate/iterate becomes a public archive, and work moves to a new
private iterate/private, created as one fresh initial commit (no shared history; PR numbers
restart). These changes land on iterate/iterate first and behave the same there until the cutover.

Status: in progress. Planned below; ci-reports' sign-in waits on Misha's choice.

Out of scope: package URLs (`tasks/package-urls-survive-repo-move.md`, in Misha's root checkout),
kit firmware (its own repo later).

## Decisions (my calls where Misha didn't say)

- **"This repository" is the running one, never a name.** One helper, `githubRepository()` in
  `scripts/ci/github.ts`: `GITHUB_REPOSITORY` in CI (Depot sets it), else the checkout's `origin`
  (a laptop), as `core/os/scripts/build.ts` already names core's configs. `getRepo()` uses it.
  Every Depot query and GitHub call that named iterate/iterate goes through it.
- **Workflow YAML is read through GitHub's API with the job's token**, not anonymous
  raw.githubusercontent.com (404 for a private repo). The telemetry sync needs files at dozens of
  commits its checkout doesn't have, so the API beats the checkout there; the trace uses the same
  helper rather than a second mechanism.
- **Release**: with no `v…` tag (the fresh repo), the changelog starts at the repo's root commit,
  not `HEAD~1` (which a one-commit repo doesn't have).
- **Copybara's origin is named per run**, as Copybara's `"<url> <ref>"` source ref: this repository
  on GitHub for a sync (with the iterate App token, now also listing this repository, found from the
  running repo so nothing names iterate/private before it exists), this checkout for a PR's check
  (`file://`, `--git-origin-fetch-depth=1`; no fetch, no token). The config's `url` is never used.
- **Re-seed**: before copying, `sync` reads each copy's last `GitOrigin-RevId` and asks GitHub
  whether this repository has that commit (422 = no). A copy that is empty, or whose last commit
  this repository lacks, is seeded with one SQUASH snapshot of the deployed commit
  (`--squash --force --last-rev <parent>`, `--init-history` for a root commit), carrying that
  commit's message. Tested locally against Copybara v20260928: ITERATIVE with `--last-rev <parent>`
  (today's empty-copy seed) copies nothing when the deployed commit touches no copied file; SQUASH
  writes the tree either way, and exits 4 (nothing to do) when the copy already holds that tree.
- **`(#N)` in copy titles** names the PR only while the source repository is public:
  `copybara.ts` asks GitHub for its visibility and passes the repository as a `--labels` value;
  from a private source the title drops the number.
- **ci-reports**: the auth choice is Misha's (see below). Its `iterate/iterate` check stays: it is
  what keeps a private repo's reports off a public viewer until sign-in exists.
- **MCP examples** move to `core/os/examples/mcp-run-scripts.mjs` (ships in iterate/core), the
  instructions link it on iterate/core, and the MCP e2e runs every script in it, as
  `serve-localhost.mjs` is pinned.

## Checklist

- [ ] `githubRepository()`; Depot queries in `scripts/ci/depot.ts`, `scripts/monitors/ttg.ts`,
      `scripts/ci/sync-ci-telemetry.ts`, `scripts/ci/tracing/cli.ts`; GitHub calls in
      `scripts/monitors/health.ts` and `tracing/cli.ts` publish
- [ ] workflow YAML via the API (`sync-ci-telemetry.ts`, `tracing/cli.ts`); the trace step gets
      `GITHUB_TOKEN`
- [ ] `release.yml` without tags
- [ ] Copybara: per-run origin, token lists the source, re-seed, `(#N)` by visibility, PR check
      from the checkout
- [ ] ci-reports: what Depot does with a private repo's artifacts; Access vs sign in with iterate,
      for Misha
- [ ] MCP example in `core/os/examples/`, link, e2e, `core/os/README.md`
- [ ] typecheck, lint, knip, format, tests

## For the cutover (not this PR)

- iterate/private: Depot CI connected, its secrets (`DOPPLER_TOKEN`), rulesets.
- Comments that say `depot ci dispatch --repo iterate/iterate` (`.depot/workflows/*.yml`).
- ci-reports: sign-in, then its repository check and an authenticated explainer read.
- Found while here, not in this task's list: `scripts/os/config-templates.ts`,
  `scripts/os/preview-config.ts` and `scripts/os-dev.ts` name templates
  `github:iterate/iterate#<sha>&path:configs/<name>`, a commit the archive won't have after the
  move; `packages/ui/src/components/app-build.tsx` links commits on iterate/iterate.

## Implementation notes
