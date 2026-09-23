# Depot CI

CI workflows live in `.depot/workflows/*.yml` and run on
[Depot CI](https://depot.dev/docs/ci/overview). The files use GitHub Actions
YAML syntax, but Depot owns the run lifecycle, check reporting, logs, metrics,
secrets, and local dispatch.

The old TypeScript workflow generator is gone. Edit the YAML directly, and put
runtime logic in normal scripts under `scripts/ci` instead of embedding large
`actions/github-script` blocks.

Historical workflow/job/attempt timing, queueing, CPU/memory utilization, and
failure-rate analysis lives in PostHog; see
[CI and test telemetry](ci-test-telemetry.md) for the dashboards, event model,
backfill (dispatch-only while PostHog delivery is off), Doppler-managed Depot
organization token and its scope caveat, and CLI/MCP queries.

## Time budget

- A merge to main just deploys: each app's deploy workflow finishes in about two minutes.
- A throwaway preview plus e2e (Main OS e2e) may run in parallel, but nothing waits on it.
- No job sleeps or waits minutes for analytics or logs to settle. Put slow-arriving signals
  (Durable Object cost, prd faults) in a scheduled alarm (`do-duration-probe.yml`,
  `prd-fault-alarm.yml`), not in a gate on the merge path.
- A scheduled run reports on main's head commit, so an alarm stays green unless it is broken: it
  pages and passes, and fails only when it could not measure or could not post. The nightly crash
  hunt (`os-next-crash-hunt.yml`) is the exception: a crash it finds is a red run, and the red run
  is what posts to #error-pulse.
- A job that only runs on a schedule lives in a schedule-only workflow, so no push or PR carries it
  as a skipped check (`scripts/ci/depot-workflows.test.ts` enforces it).
- Build expensive artifacts once and consume them, instead of rebuilding them on every deploy.
- Run a suite on one account, not repeated on others.

## Quick Links

- [Depot CI dashboard](https://depot.dev/orgs/0p91s0lz49/workflows)
- [Depot CI docs](https://depot.dev/docs/ci/overview)
- [Depot CI compatibility](https://depot.dev/docs/ci/compatibility)
- [Depot CI CLI reference](https://depot.dev/docs/cli/reference/depot-ci)
- [Manage workflow runs](https://depot.dev/docs/ci/how-to-guides/manage-workflow-runs)
- [Custom images](https://depot.dev/docs/ci/how-to-guides/custom-images)
- [Parallel steps](https://depot.dev/docs/ci/how-to-guides/parallel-steps)

## Repo Defaults

- Depot org: `0p91s0lz49`
- GitHub repo: `iterate/iterate`
- Workflow files: `.depot/workflows/*.yml`
- CI scripts: `scripts/ci/*.ts`
- Custom image:
  `0p91s0lz49.registry.depot.dev/iterate-preview-ci:node24-pnpm10-worktree`
- `DOPPLER_TOKEN` is the only Depot CI secret. Application and service
  credentials live in Doppler; GitHub supplies a short-lived job token.
- Non-secret variables are managed with `depot ci vars`.

The only GitHub Actions workflow left is `.github/workflows/pkg-pr-new.yml`. It
is not CI; it publishes the `iterate` SDK package to
[pkg.pr.new](https://pkg.pr.new) for every `main` push, and for a PR that changes
the SDK's inputs (`packages/iterate`, the root manifests and lockfile, or the
workflow itself): the **publish** and **Continuous Releases** checks. Anything else that needs GitHub-only triggers,
such as `issues`, `issue_comment`, or PR review comment events, which Depot CI
does not support, belongs there too.

## Commands

Start with the built-in help when unsure:

```bash
depot ci --help
depot ci run --help
depot ci dispatch --help
depot ci status --help
```

List active or recent runs:

```bash
depot ci run list --org 0p91s0lz49 --repo iterate/iterate
depot ci run list --org 0p91s0lz49 --repo iterate/iterate --pr <pr-number>
depot ci run list --org 0p91s0lz49 --repo iterate/iterate --sha <sha-prefix>
depot ci run list --org 0p91s0lz49 --repo iterate/iterate --status failed
depot ci run list --org 0p91s0lz49 --repo iterate/iterate --output json
```

Inspect a run:

```bash
depot ci status <run-id> --org 0p91s0lz49
depot ci status <run-id> --org 0p91s0lz49 --output json
depot ci run show <run-id> --org 0p91s0lz49
```

Fetch logs and diagnostics:

```bash
depot ci logs <attempt-id> --org 0p91s0lz49
depot ci logs <job-id> --org 0p91s0lz49 --follow
depot ci metrics --run <run-id> --org 0p91s0lz49
depot ci diagnose <run-id> --org 0p91s0lz49
depot ci summary <attempt-id> --org 0p91s0lz49
```

List and download retained artifacts:

```bash
depot_run_id="<run-id>"
depot ci artifacts list "$depot_run_id" --org 0p91s0lz49 --output json
artifact_id="<artifact-id>"
depot ci artifacts download "$artifact_id" \
  --org 0p91s0lz49 \
  --output-file /tmp/unit-test-telemetry.zip
```

For a Depot-hosted workflow, use `depot ci artifacts` as the source of truth.
The `actions/upload-artifact` log may print a GitHub-looking actions URL, but
Depot owns the run and artifact; `gh run download` and the GitHub Actions
artifact API can return 404 for that URL.

Control runs:

```bash
depot ci rerun <run-id> --org 0p91s0lz49
depot ci retry <run-id> --org 0p91s0lz49
depot ci cancel <run-id> --org 0p91s0lz49
```

Manage secrets:

```bash
depot ci secrets list --org 0p91s0lz49
```

The list must contain only `DOPPLER_TOKEN`. Do not copy GitHub, Depot API,
Cloudflare, Slack, PostHog, or other service credentials into Depot. Put them
in the appropriate Doppler config; CI reaches them through the bootstrap
token. GitHub operations use `${{ github.token }}` and workflow-level
`permissions` instead of a stored bot token. The CI telemetry collector is the
non-obvious case: its Depot organization token lives in `_shared/preview`, but
the collector sends under `_shared/prd` so it reaches the canonical PostHog
project. See [CI and test telemetry](ci-test-telemetry.md) for the exact setup.

The daily PR dashboard also avoids a hidden token exception: it finds today's
message and detail reply through Slack history instead of persisting their
timestamps in a GitHub Actions repository variable. GitHub's variable API
requires the separate
[repository `Variables` permission](https://docs.github.com/en/rest/actions/variables#get-a-repository-variable),
which workflow `GITHUB_TOKEN` permissions cannot request. Do not reintroduce
`SLACK_PR_DASHBOARD_STATE` or a personal/bot token for that state.

## Wait For CI

Depot CLI does not currently have a blocking `wait` subcommand. The monitoring
command we use is a `watch` loop around `depot ci run list` or
`depot ci status`.

For a PR:

```bash
watch -n 15 \
  'depot ci run list --org 0p91s0lz49 --repo iterate/iterate --pr <pr-number> -n 20'
```

For a known run:

```bash
watch -n 15 'depot ci status <run-id> --org 0p91s0lz49'
```

Use `status` to find the failed job/attempt id, then fetch logs:

```bash
depot ci status <run-id> --org 0p91s0lz49
depot ci logs <attempt-id> --org 0p91s0lz49
```

For scriptable polling, ask Depot for JSON:

```bash
depot ci run list --org 0p91s0lz49 --repo iterate/iterate --pr <pr-number> --output json
depot ci status <run-id> --org 0p91s0lz49 --output json
```

### Agent wait loops: gate on the head commit's check-runs

Hand-rolled "wait for green" loops (agents babysitting a PR) keep failing the
same three ways. The rules that survive contact:

1. **Poll the head commit's check-runs, never `gh pr checks` text.** Right
   after a push there is a window where the previous head's checks are gone
   and the new head's are not registered yet — a `grep -c pending` gate reads
   that empty moment as "all done" and exits before CI even starts. Ask for
   the checks OF THE COMMIT and require the ones you care about to exist and
   be `completed`:

   ```bash
   HEAD=$(git rev-parse HEAD)
   gh api "repos/iterate/iterate/commits/$HEAD/check-runs?per_page=100" \
     -q '[.check_runs[] | {name, status, conclusion}]'
   ```

2. **Never wait for "Cursor Bugbot posted a review for `<sha>`".** Bugbot
   SKIPS pushes it deems trivial (merge commits especially) — the check ends
   in `skipped` and no review naming that sha ever appears, so a review-body
   gate spins until its iteration cap and then reports hour-stale state.
   Gate on the Bugbot check-run reaching a terminal `status: completed`
   (conclusion `success`/`skipped`/`neutral` all mean "bugbot is done"), and
   read FINDINGS from unresolved review threads, which is also what blocks
   merges:

   ```bash
   gh api graphql -f query='{ repository(owner: "iterate", name: "iterate") {
     pullRequest(number: <pr>) { reviewThreads(first: 60) { nodes { isResolved } } } } }' \
     -q '[.data.repository.pullRequest.reviewThreads.nodes[] | select(.isResolved == false)] | length'
   ```

3. **A push obsoletes every running monitor.** A loop started before a push
   waits on answers about a head that no longer exists. Kill it and start a
   fresh one pinned to `git rev-parse HEAD`; print that sha as the loop's
   first line so a stale monitor is recognizable at a glance.

Also know what actually blocks the merge: `gh pr view --json mergeStateStatus`
answers `BLOCKED` (required things missing — the `main` ruleset requires
**Lint and Typecheck / lint-typecheck** and **Test / test**), `UNSTABLE`
(something failing that is NOT required — the Preview OS deploy and e2e are in
this category), or `CLEAN`. A wait-for-green loop that treats `UNSTABLE` as
fatal waits forever on a red non-required check. GitHub does not enforce
review-thread resolution on `main`; the [PR workflow](pull-requests.md) does.

## Run A Workflow From Your Checkout

`depot ci run` runs a workflow through Depot using your local checkout. If you
have local changes, Depot uploads them as a patch and applies them in the CI
sandbox.

```bash
depot ci run --org 0p91s0lz49 --workflow .depot/workflows/lint-typecheck.yml
depot ci run --org 0p91s0lz49 --workflow .depot/workflows/test.yml --job test
```

Use SSH for interactive debugging of a single job:

```bash
depot ci run --org 0p91s0lz49 \
  --workflow .depot/workflows/test.yml \
  --job test \
  --ssh
```

## Dispatch A Checked-In Workflow

Use `dispatch` for workflows with `workflow_dispatch`. The `--workflow` value is
the file basename, not the full path.

```bash
depot ci dispatch --org 0p91s0lz49 --repo iterate/iterate \
  --workflow preview-os-next.yml \
  --ref <branch> \
  --input pull-request-number=<pr-number> \
  --input action=deploy
```

`action` is `deploy | reset | e2e` and `apps` is
`all | auto | none` (the clients on top of the platform preview); the header of
`.depot/workflows/preview-os-next.yml` documents each. Deleting a PR's preview
and the nightly preview sweep are workflows of their own: dispatch
`preview-delete.yml` (`--input pull-request-number=<pr-number>`) to delete one
now, `preview-sweep.yml` (no inputs) to sweep now.

Deploy a branch manually:

```bash
depot ci dispatch --org 0p91s0lz49 --repo iterate/iterate \
  --workflow deploy-os-next.yml \
  --ref <branch> \
  --input ref=<branch>
```

The job runs the deployed ref's own scripts. A ref whose
`scripts/ci/prd-post-deploy-check.ts check` has no `--previous-version` option
(any commit from before 2026-09-24, so most rollbacks) deploys prd and then
fails its `Check the project hosts` step. Check the hosts from `main` by hand:
`pnpm tsx scripts/ci/prd-post-deploy-check.ts check --dry-run`.

## Editing Workflows

1. Edit `.depot/workflows/<name>.yml`.
2. If a step needs real logic, add or update a script under `scripts/ci`.
3. Validate the workflow locally with `depot ci run`.
4. Watch the PR checks in GitHub or with the `watch` commands above.

Prefer small YAML wrappers around scripts. For example:

```yaml
- name: Notify Slack on failure
  run: pnpm tsx scripts/ci/notify.ts workflow-failure
```

Use Depot-specific features where they make the workflow clearer:

- custom-image jobs declare both `runs-on.size` and `runs-on.image`;
- `actions/checkout` uses `clean: false` when consuming the baked image;
- independent checks can use Depot `parallel:` blocks with `fail-fast: false`;
- workflow runtime logic belongs in `scripts/ci`, not in long YAML strings.

### Reliability defaults

Mainline workflows deliberately separate deployment safety from validation
freshness:

- A credentialed deploy uses one fixed concurrency group named for its actual
  destination, such as `deploy-os-next-production`. It always sets
  `cancel-in-progress: false`. The checked-out branch is not the destination,
  so it must not appear in that group name. An active rollout finishes; if
  several newer commits queue behind it, Depot keeps the newest pending run.
- Tests and lint/typecheck use the source branch (falling back to
  `ref_name`) and `cancel-in-progress: true`. A newer commit makes an older
  validation result obsolete, including on `main`.
- Every mainline job has `timeout-minutes`. This is a watchdog, not a retry:
  jobs fail at the outer edge and an operator decides whether a rerun is safe.
  Deploy OS gets 30 minutes: its bounded worst case is the build, the rollout,
  the deploy script's readiness probes, the host check (≤ 60 s for `/version`
  to name the new version, then four tries of each production project host)
  and its Slack notice, all in the one job. Deploy Kit also gets 30, the other
  client deploys 15–20, and notification jobs 10.
- Runner size follows observed peak CPU and memory, with headroom. Lint stays
  on `8x32` (parallel oxlint/typecheck/format check/knip). Unit tests use `4x16` — measured
  peaks on `8x32` were ~3 cores / ~2.5GB, and a second large sandbox next to
  lint is the common trigger for no-log `Sandbox terminated before worker
reported completion` on main. Deploy OS and Deploy Kit use `4x16`; the client
  deploys (Dash, Agents, Notes, Voice, SPA, dummy-petshop), notification jobs,
  and the jobs that only call APIs (LOC report, PR dashboard, Release) use
  `2x8`. Re-check with `depot ci metrics --run <run-id>`
  before increasing a size.

These defaults keep a normal all-app main push to 36 requested vCPUs before
notification jobs (lint 8, test 4, Deploy OS 4, Deploy Kit 4, 2 for each of the
six client deploys, and 4 for Main OS e2e, whose parent, deploy and e2e jobs run
one after another), without reducing the parallel lint lane that uses the larger
machine. The sizing pass that set them cut the then-larger
workflow set from 72 requested vCPUs to 28.

If an attempt receives a sandbox but produces no logs or metrics before
failing, inspect `depot ci status`, `logs`, `metrics`, and `diagnose`. When the
same commit and image pass on rerun, treat that as runner provisioning evidence,
not an application failure. Do not add automatic workflow retries: deployment
reruns can repeat external side effects and need an operator decision.

## Custom Image

The baked image is built by `.depot/workflows/build-preview-ci-image.yml` using
`scripts/depot-ci/bake-preview-ci-image.sh`.

It contains Node, pnpm, workspace dependencies, Doppler CLI, and the preview
browser. A snapshot is independent of sandbox size: choose `2x8`, `4x16`,
`8x32`, or `16x64` from measured workload demand. Preview deploy and e2e run on
`4x16`; the e2e job runs Vitest and Playwright concurrently against the one
preview. The image rebuilds when
dependency manifests or its bake inputs land on `main`, with a weekly scheduled
rebuild as drift repair. The Preview OS, Preview sweep, Deploy OS, Main OS e2e,
Lint and Typecheck, OS crash hunt and OS e2e soak jobs run
`node scripts/depot-ci/dependencies.mjs install`: an exact
baked fingerprint reuses the installed tree without starting pnpm. A mismatch
or missing receipt runs `pnpm install --frozen-lockfile --prefer-offline`.
Other workflows still always run that pnpm command. The Test job does so
deliberately: the image loads
lazily, and the install is what pages the tree in before the first tests (with
reuse, 5 s test rows timed out in three of three runs). Jobs that consume the
image must keep the image and checkout behavior, and set the store the image was
baked with (`PNPM_CONFIG_STORE_DIR: /home/runner/.pnpm-store`), because every
`pnpm_config_*` variable is part of the fingerprint:

```yaml
runs-on:
  size: 2x8 # workload-specific
  image: 0p91s0lz49.registry.depot.dev/iterate-preview-ci:node24-pnpm10-worktree
steps:
  - uses: actions/checkout@v4
    with:
      clean: false
```

`clean: false` matters because the image contains a preinstalled workspace. A
clean checkout would delete the baked `node_modules` before `pnpm install` can
reuse it.

### Preview dependency fingerprints

The image bake uses a frozen install and takes pnpm's version from the root
`packageManager`. After setup succeeds it seals `node_modules` with a receipt.
Snapshots publish both the normal image tag and `deps-<fingerprint>`; the
receipt inside the image is authoritative, so moving a tag cannot create a
false hit. The `image-tag` dispatch input allows isolated experiment images.

The fingerprint includes the lockfile, manifests (including new/deleted ones;
only their install fields, so editing a package's `test` script does not force a
reinstall), workspace config, pnpm hook, npm config, patches, local file dependency sources,
bake script, verifier, checkout path, Node version, OS/architecture and install
configuration environment. Reuse also checks pnpm's installed metadata and the
workspace module directory listings. New workspace lifecycle scripts disable
reuse; the current root `is-ci || husky` prepare is a no-op in CI.

This receipt is for a pristine Depot filesystem snapshot, consumed immediately
after `checkout` with `clean: false`. It is not a general cache-integrity checker:
verifying every installed file would recreate the filesystem cost being removed.
Do not mutate dependencies before the verification step. Missing or changed
inputs run the normal frozen install, and invalidate the old receipt before
installing. An image without a matching fingerprint is a cache miss even if the
previous PR commit had the same lockfile. Only successful image bakes publish
reusable state; misses are deliberately not optimized here.

Normal CI still uses the rolling image tag so selecting it adds no preliminary
job. The fingerprint tag makes the exact snapshot addressable and inspectable;
consumers validate its receipt rather than trusting the tag's spelling. No
package-manager migration is needed to bypass installation on a match.

## Trigger Gotchas

Depot registers automatic triggers from the default branch. If you change an
`on:` block on a feature branch, automatic `push` or `pull_request` behavior may
not be visible until the workflow file lands on `main`. Use `depot ci run` for
local workflow validation and `depot ci dispatch` for `workflow_dispatch`
coverage.

`workflow_dispatch` and automatic PR runs can share concurrency groups, and so
can two workflows that name the same group: Depot wakes "a peer workflow in the
same concurrency group" when the slot frees
([Depot's orchestrator](https://depot.dev/blog/building-ci-with-durable-lambda)),
as GitHub does. For the Preview OS workflow, a manual dispatch, an automatic PR
run and the Preview delete run for the same PR share `preview-os-next-<pr>` with
`cancel-in-progress: false`: neither cancels the running one, but a newer
pending run replaces an older pending one, so a dispatch queued behind a push
can silently disappear. When validating previews, use one path at a time.

`depot ci logs` accepts a run id, job id, or attempt id. When a run has multiple
jobs, pass `--job <job-key>` or use `depot ci status <run-id> --output json` to
find the exact job/attempt id.

## Which PRs get a preview

The Preview OS workflow (`.depot/workflows/preview-os-next.yml`, cribbed from
cloudflare-os) selects PRs by its `pull_request.paths` list: `apps/os`,
`configs-next`, the five hosted clients (`apps/dash`, `apps/agents`,
`apps/notes`, `apps/voice`, `apps/kit` but not its firmware), `packages/iterate`, `packages/shared`,
`packages/ui`, the root manifests and lockfile, `envs.ts`, `scripts/lib`,
`scripts/depot-ci`, and its own and the production OS/Notes deploy workflows
(a production-workflow change must exercise the isolated deployment). A PR that
touches none of them, such as docs, lint rules or Kit firmware, gets no preview
checks at all: they never appear, rather than reporting a skip. The Preview
delete workflow (`.depot/workflows/preview-delete.yml`) runs on the same list
when such a PR closes; `scripts/ci/depot-workflows.test.ts` keeps the two lists
equal.

## Preview job shape

The Preview OS workflow runs **deploy**, then **e2e** as a separate job with
`needs: deploy` (#2861). The e2e job starts only behind a deploy that succeeded,
or alone on an `action=e2e` dispatch, then runs the Vitest e2e suite and the
Playwright specs concurrently against the live preview (`runE2e` in
`apps/os/scripts/preview.ts`). Job dependencies replace milestone signalling:
there is no commit status to wait for, and a red e2e can run again without a
redeploy (dispatch `action=e2e`, or retry the job), because the preview persists
until the PR closes.

The legacy fleet's overlap experiment (PR #2659) went the other way. It started
preparation, app tests and six Playwright shards together. Test jobs reconciled
dependencies and browsers before waiting for `preview-ready`. Preparation
uploaded the immutable deployment plan before publishing that GitHub commit
status. `scripts/ci/status.ts` scoped the signal to the Depot workflow,
execution, producer job and attempt, and checked producer liveness on each poll.
The finalizer needed only preparation; one `wait-for-jobs` call polled all seven
consumers together, and only a confirmed terminal state for every consumer
authorized cleanup. `scripts/ci/status.ts` went with that pipeline in #2837.

Its rules still hold for any workflow that overlaps jobs again:

- A terminated producer without its signal fails the wait. Reaching a milestone
  releases consumers even while the producer continues collecting artifacts.
- Failed consumers are collected and fail the final result; report
  download/merge validates the full test result before any early-green update.
- Coordination reads Depot's API with the existing Doppler-managed
  `DEPOT_CI_TELEMETRY_TOKEN` from `_shared/preview`; it does not introduce a
  Depot secret or copy a personal token. GitHub milestones use the job token
  with `statuses: write`. The organization token has broad scope, as documented
  above.
- Validate with a fresh push or workflow dispatch, not retry/rerun, whenever a
  retry would reuse an erased deployment or accept an old plan artifact. Normal
  Playwright/Vitest test retries are unchanged.

## Interactive trace reports

The Preview OS workflow's `trace` job publishes a **CI trace** commit status
after deploy and e2e, whatever their outcome: the time to green or red, linked
to the job on Depot, where the `public-ci-trace-<workflow>-<execution>`
artifact (`trace.html`, `trace.json`) downloads. The report shows workflow →
jobs → setup/wait/test/finish → shell steps → Playwright attempts and Vitest
tests. The legacy preview workflows published the same status from webhooks
and served the report in place; that host went with #2837, so download the
artifact and open `trace.html`. See [CI traces](./ci-traces.md) for the timing
model, publishing, replay commands and OTLP JSON export.

## Browser reports from artifacts

A browser-readable report is uploaded as a Depot artifact even after test
failures, and the check keeps the actual test outcome: a report link means the
report is available, nothing more. Links use Depot artifact UUIDs and expire
with their 30-day retention. Upload only files intended to be public.

The Preview OS e2e job prints Playwright's report into the job log after
Vitest's, and uploads two artifacts even when the suite fails:

- `public-playwright-report`: Playwright's HTML report
  (`test-results/playwright-html`), kept 30 days.
- `preview-os-test-artifacts`: all of `test-results/`. Each failed spec's
  `trace.zip`, screenshot and `error-context.md` are under
  `playwright-output/<test>/`, next to `playwright-results.json` and the
  telemetry.

Fetch either with `depot ci artifacts` as shown above, unzip, and open it with
`pnpm exec playwright show-report <dir>` or
`pnpm exec playwright show-trace <trace.zip>`. The Test workflow uploads
`unit-test-telemetry` and `flake-records-unit`.

The legacy preview finalizer uploaded the merged Playwright HTML directory as
`public-playwright-report`. The legacy platform's `iterate` config project
handled Depot `check_run.completed` webhooks, added a **Playwright report**
commit status alongside **CI trace**, and served each artifact at
`https://depot-<id>--iterate.iterate.app/`: `/foo.xyz` served ZIP entry
`foo.xyz`, a root `index.html` opened directly, a single-file artifact
redirected to that file, and other artifacts got a generated index. Relative
assets and binary attachments were served from the ZIP using range reads. Each
artifact got a separate origin, so HTML reports could use browser storage and
service workers without sharing the project's origin. Artifacts opted in with a
`public-` name prefix, and `?download` downloaded a file instead of displaying
it. That viewer no longer answers: `*.iterate.app` now routes to the OS
platform, which has no such app (a request returns 404, "no rewrite rule
matches").
