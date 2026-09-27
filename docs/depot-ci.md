# Depot CI

CI workflows live in `.depot/workflows/*.yml` and run on
[Depot CI](https://depot.dev/docs/ci/overview). The files use GitHub Actions
YAML syntax, but Depot owns the run lifecycle, check reporting, logs, metrics,
secrets, and local dispatch.

Edit the YAML directly, and put runtime logic in normal scripts under `scripts/ci` instead of embedding large
`actions/github-script` blocks.

Workflow-run and job-attempt history goes to PostHog from an hourly sync
([CI and test telemetry](ci-test-telemetry.md)).

## Time budget

- A merge to main just deploys: each app's deploy workflow finishes in about two minutes, and
  runs only when the merge touches what that app ships ([Which main pushes deploy](#which-main-pushes-deploy)).
- Main OS e2e (its preview redeployed in place, then e2e) may run in parallel, but nothing waits
  on it ([Main OS e2e keeps one preview](#main-os-e2e-keeps-one-preview)).
- No job sleeps or waits minutes for analytics or logs to settle. Put slow-arriving signals
  (Durable Object cost, prd faults) in a scheduled alarm (`health.yml`,
  `prd-fault-alarm.yml`), not in a gate on the merge path.
- A scheduled run reports on main's head commit, so an alarm stays green unless it is broken: it
  pages and passes, and fails only when it could not measure or could not post. The nightly crash
  hunt (`os-crash-hunt.yml`) is the exception: a crash it finds is a red run, and the red run
  is what posts to #error-pulse.
- A job that only runs on a schedule lives in a schedule-only workflow, so no push or PR carries it
  as a skipped check (`scripts/ci/depot-workflows.test.ts` enforces it).
- Build expensive artifacts once and consume them, instead of rebuilding them on every deploy.
- Run a suite on one account, not repeated on others.

## Quick Links

[Dashboard](https://depot.dev/orgs/0p91s0lz49/workflows) ·
[docs](https://depot.dev/docs/ci/overview) ·
[compatibility](https://depot.dev/docs/ci/compatibility) ·
[CLI reference](https://depot.dev/docs/cli/reference/depot-ci)

## Repo Defaults

- Depot org: `0p91s0lz49`
- GitHub repo: `iterate/iterate`
- Workflow files: `.depot/workflows/*.yml`
- CI scripts: `scripts/ci/*.ts`
- Custom image:
  `0p91s0lz49.registry.depot.dev/iterate-preview-ci:node24-pnpm10-worktree`;
  Kit Firmware's build legs run on their own,
  `0p91s0lz49.registry.depot.dev/iterate-esp-idf-ci:node24`
- `DOPPLER_TOKEN` is the only Depot CI secret. Application and service
  credentials live in Doppler; GitHub supplies a short-lived job token.
- Non-secret variables are managed with `depot ci vars`.

Two GitHub Actions workflows are left, both for what Depot cannot do:

- `.github/workflows/pkg-pr-new.yml` is not CI; it publishes the `iterate` SDK, the
  `@iterate-com/cli`, `@iterate-com/petshop-sdk`, `@iterate-com/agents` and `@iterate-com/voice`
  packages to [pkg.pr.new](https://pkg.pr.new) for every `main` push, and for a PR that changes
  their inputs (their `packages/*` folders, `packages/shared`, the root manifests and lockfile, or
  the workflow itself): the **publish** and **Continuous Releases** checks. Projects install
  agents and voice from these builds, and the e2e rows that prove it pin the PR head's.
- `.github/workflows/merges-with-main.yml` is the **Merges with main** check, on
  `pull_request_target`: a PR that conflicts with main gets a red check instead of none
  ([Pull requests that conflict with main](#pull-requests-that-conflict-with-main)).

Anything else that needs GitHub-only triggers, such as `pull_request_target`, `issues`,
`issue_comment`, or PR review comment events, which Depot CI does not support, belongs there too.

## Workflows

| File                         | Runs on                                             | What it does                                                                                            |
| ---------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `lint-typecheck.yml`         | PR, main push, dispatch                             | **Lint and Typecheck** (required): lint, typecheck, format check, knip                                  |
| `test.yml`                   | PR, main push                                       | **Test** (required): `pnpm test`, then the Kit firmware host tests                                      |
| `loc-report.yml`             | PR, dispatch                                        | The LOC table in the PR body                                                                            |
| `pr-dashboard.yml`           | PR opened, reopened, ready, drafted or closed       | The Slack PR update and the daily PR dashboard                                                          |
| `preview-os.yml`             | Every PR, dispatch                                  | **Preview OS**: Deploy preview, then **E2E tests** and **Browser specs**, then CI trace                 |
| `preview-delete.yml`         | Such a PR closing, dispatch                         | Deletes the PR's preview                                                                                |
| `preview-sweep.yml`          | Nightly, dispatch                                   | Deletes stale previews and orphaned preview resources                                                   |
| `main-os-e2e.yml`            | Main push touching the preview paths, dispatch      | **Main OS e2e**: main redeployed in place to preview `main`, E2E tests, Browser specs, its page, trace  |
| `deploy-os.yml`              | Main push touching what OS ships, dispatch          | **Deploy OS**: production, then the project-host check                                                  |
| `deploy-<app>.yml`           | Main push touching what the app ships, dispatch     | Deploy of Dash, Agents, Notes, Voice, Kit, SPA, dummy-petshop or ci-reports                             |
| `kit-firmware.yml`           | Firmware PR and main push, daily, dispatch          | Builds the changed boards; main publishes their releases                                                |
| `build-preview-ci-image.yml` | Main push touching install inputs, weekly, dispatch | Bakes the CI image ([Custom Image](#custom-image)) when the live image's stamp is stale                 |
| `build-esp-idf-image.yml`    | Main push touching `esp-idf.sh`, weekly, dispatch   | Bakes Kit Firmware's legs' image: Node 24 and ESP-IDF ([Kit firmware releases](#kit-firmware-releases)) |
| `prd-fault-alarm.yml`        | Every 15 minutes, dispatch                          | Reads production's Workers Logs and pages #error-pulse on faults                                        |
| `health.yml`                 | Hourly, dispatch                                    | **Health**: judges the runs below and PR time to green; one #error-pulse message per change of state    |
| `os-crash-hunt.yml`          | Nightly, dispatch                                   | The opt-in isolate-ceiling rows against production                                                      |
| `os-e2e-soak.yml`            | Dispatch                                            | The e2e suite N times against one deployed worker, each run then the perf budgets                       |
| `os-latency.yml`             | Every 3 hours, dispatch                             | **OS latency**: the perf suite against main's preview `latency`, its report for the health job          |
| `os-real-model.yml`          | Daily, main push to the agents runtime, dispatch    | **OS real model**: the `REAL:` rows against main's preview `real-model`, for the health job             |
| `flake-dashboard.yml`        | Hourly, dispatch                                    | Recomputes [#2580](https://github.com/iterate/iterate/issues/2580) from the flake records in R2         |
| `ci-telemetry.yml`           | Hourly, dispatch                                    | One PostHog event per Depot workflow run and job attempt                                                |
| `release.yml`                | Daily, dispatch                                     | A dated `v…` release with a changelog when main moved                                                   |
| `shadcn-drift.yml`           | PR touching the vendored shadcn files, dispatch     | **shadcn drift**: fails when a vendored file differs from `shadcn add` (packages/ui/AGENTS.md)          |

Each file's header comment and `on:` block are the details.

## Commands

`depot ci <command> --help` when unsure. Every command takes `--org 0p91s0lz49`, and `--output json`
for scripts:

```bash
depot ci run list --org 0p91s0lz49 --repo iterate/iterate [--pr <n> | --sha <prefix> | --status failed]
depot ci status <run-id> --org 0p91s0lz49          # jobs and attempt ids
depot ci run show <run-id> --org 0p91s0lz49
depot ci logs <attempt-id> --org 0p91s0lz49        # or <job-id> --follow
depot ci metrics --run <run-id> --org 0p91s0lz49
depot ci diagnose --run <run-id> --org 0p91s0lz49
depot ci summary <attempt-id> --org 0p91s0lz49
depot ci rerun <run-id> --org 0p91s0lz49             # or retry, cancel
depot ci artifacts list <run-id> --org 0p91s0lz49 --output json
artifact_id="<artifact-id>"
depot ci artifacts download "$artifact_id" \
  --org 0p91s0lz49 \
  --output-file /tmp/unit-test-telemetry.zip
```

`depot ci artifacts` is the source of truth for artifacts: the GitHub-looking URL that
`actions/upload-artifact` prints 404s for `gh run download`.

### Artifacts per job attempt

The Test job and the preview and main test jobs name every evidence artifact
after the job attempt that uploaded it: `flake-records-<suite>-attempt-<id>`
and `<unit|preview-os|main-os>-test-artifacts-attempt-<id>`. The job's first step reads `<id>` from `DEPOT_JOB_URL`
(`…?job=<job>&attempt=<id>`), and `depot ci artifacts list` shows the same id
as each artifact's `attempt_id`. A retried job therefore keeps the failed
attempt's telemetry, flake records and Playwright traces beside the retry's.

Never give evidence a fixed name with `overwrite: true`: the retry's upload deletes every
same-named artifact in the run, the failed attempt's included.
`scripts/ci/depot-workflows.test.ts` enforces the naming. The one exception is
`public-playwright-report`, whose fixed name links the latest attempt's report; every attempt's own
copy is in its `preview-os-test-artifacts-attempt-<id>`.

### Secrets

`depot ci secrets list --org 0p91s0lz49` must show only `DOPPLER_TOKEN`. Every other credential
lives in Doppler, reached through that token; GitHub operations use `${{ github.token }}` and
workflow `permissions`, never a stored bot token. The PR dashboard finds its Slack messages through
Slack history: do not reintroduce `SLACK_PR_DASHBOARD_STATE` or a token for it (GitHub's variable
API needs a permission `GITHUB_TOKEN` cannot request).

## Wait For CI

Depot has no blocking `wait`; poll:

```bash
watch -n 15 'depot ci run list --org 0p91s0lz49 --repo iterate/iterate --pr <pr-number> -n 20'
watch -n 15 'depot ci status <run-id> --org 0p91s0lz49'
```

Agents babysitting a PR: the wait-loop rules are in
[Pull requests](pull-requests.md#agent-wait-loops-gate-on-the-head-commits-check-runs).

## Run CI without a PR

Never open a pull request only to run CI, and never run CI on main's commit. Push a scratch branch
(main plus an empty commit, or the commit to soak) under its own name and run against its head.
`depot ci run` runs any workflow file, whatever its `on:` (Test has no `workflow_dispatch`);
`depot ci dispatch` runs one that has `workflow_dispatch`, with inputs. Auth: `depot login`, or the
organization token from Doppler:

```bash
export DEPOT_TOKEN="$(doppler secrets get DEPOT_CI_TELEMETRY_TOKEN --plain --project _shared --config preview)"

git fetch origin main
git worktree add -b ci-soak/<name> ../ci-soak-<name> origin/main
cd ../ci-soak-<name>
git commit --allow-empty -m "ci soak <name>"
git push -u origin HEAD        # also creates the local origin/ci-soak/<name>

depot ci run --org 0p91s0lz49 --workflow .depot/workflows/test.yml
depot ci run --org 0p91s0lz49 --workflow .depot/workflows/lint-typecheck.yml
depot ci dispatch --org 0p91s0lz49 --repo iterate/iterate --workflow os-e2e-soak.yml \
  --ref ci-soak/<name> --input runs=20 --input preview=soak-<name>
depot ci run --org 0p91s0lz49 --workflow .depot/workflows/test.yml --job test --ssh   # debug one job
```

When done: `git push origin --delete ci-soak/<name>`, remove the worktree, and delete any preview
the soak named (`pnpm --dir apps/os preview delete --name soak-<name>`).

### The commit a run reports on

`depot ci run` diffs the working tree against the local `origin/<branch>`, else the merge base with
`origin/main` ([depot/cli `findMergeBase`](https://github.com/depot/cli/blob/v2.102.13/pkg/cmd/ci/run.go)),
and every check lands on that base commit:

- A pushed branch with nothing unpushed: `HEAD`, and no `Base:` line.
- Uncommitted or unpushed changes on it: `Base: origin/<branch>`, the changes applied as a patch.
  Use this to try a workflow edit without pushing it.
- No local `origin/<branch>` (unpushed, pushed under another name, detached `HEAD`):
  `Base: origin/main`, and the checks land on main's head. Stop and push the branch under its own
  name.
- A clean `main`: main's head with `GITHUB_REF=refs/heads/main`, sharing main's concurrency groups,
  so it can cancel main's own run.

`depot ci dispatch --ref <branch>` reports on the branch's head. GitHub shows a commit's latest
check per job name, so count a soak in Depot, and check where a run's checks went:

```bash
gh api "repos/iterate/iterate/commits/$(git rev-parse HEAD)/check-runs" --jq '.check_runs[].name'
```

### What the jobs see

|                                                     | `depot ci run`                      | `depot ci dispatch --ref ci-soak/<name>`                                         |
| --------------------------------------------------- | ----------------------------------- | -------------------------------------------------------------------------------- |
| `github.event_name`                                 | `api`                               | `workflow_dispatch`                                                              |
| `github.ref` / `ref_name`                           | empty                               | `refs/heads/ci-soak/<name>` / `ci-soak/<name>`                                   |
| `github.sha`                                        | the commit above                    | the branch's head                                                                |
| `github.event`                                      | `repository` only                   | `inputs`, `ref`, `repository`, `workflow`                                        |
| `inputs.*`                                          | empty: defaults are not applied     | as given, else the defaults                                                      |
| Which workflows                                     | any file, local or committed        | `workflow_dispatch` ones, read from the branch (one only the branch has too)     |
| `if: github.event_name == 'pull_request'` jobs      | skipped                             | skipped                                                                          |
| Group `x-${{ head_ref \|\| ref_name \|\| run_id }}` | the run id: N runs run side by side | `x-ci-soak/<name>`: with `cancel-in-progress`, a dispatch cancels the one before |

Preview OS under `ci run` skips every job: dispatch it. LOC report under `ci run` writes no body. A
scratch run's test evidence goes to R2 under `trust=pr`. `status` and `artifacts list` name a
`ci run` run's jobs `_inline_0.yaml:<job>`.

### Soak: N runs, then read them

Test or Lint and Typecheck: N `depot ci run`s side by side. The e2e suite: `os-e2e-soak.yml`'s
`runs` input, not N dispatches. Preview OS dispatches that name no PR share one concurrency group,
`preview-os-none`, where a newer pending run replaces an older one.

```bash
for i in $(seq 10); do
  depot ci run --org 0p91s0lz49 --workflow .depot/workflows/test.yml | awk '/^Run:/ {print $2}'
done | tee soak-runs.txt

# the tally; --name takes the workflow's name: ("Lint and Typecheck"). Rerun until none is queued or running.
depot ci workflow list --org 0p91s0lz49 --repo iterate/iterate --name Test \
  --sha "$(git rev-parse HEAD)" -n 200 --output json \
  --status queued --status running --status finished --status failed --status cancelled |
  jq -r 'group_by(.status)[] | "\(.[0].status) \(length)"'
```

Read each run with the [commands](#commands) above; `depot ci summary` on a Test attempt says where
its R2 evidence went.

## Dispatch A Checked-In Workflow

Use `dispatch` for workflows with `workflow_dispatch`. The `--workflow` value is
the file basename, not the full path.

```bash
depot ci dispatch --org 0p91s0lz49 --repo iterate/iterate \
  --workflow preview-os.yml \
  --ref <branch> \
  --input pull-request-number=<pr-number> \
  --input action=deploy
```

Preview OS's inputs are documented in its header: `action` (`deploy | reset | test | e2e | specs`;
`deploy` and `reset` deploy and then run both suites, as a push does), `apps`
(`all | auto | none`) and `slow-rows` (`run | skip`, [slow rows](testing.md#slow-rows)).

### Run the suites against a deployed preview

`test` runs E2E tests and Browser specs against a preview as it is deployed,
without redeploying it; `e2e` and `specs` run one of them. Name the preview by
`pull-request-number`, and the jobs test that PR merged into main, or by
`preview-name` without a number (a PR's `pr<n>`, or `main`, the one Main OS
e2e keeps), and they run the dispatched ref's suite:

```bash
# both suites against PR 1234's preview, from a scratch branch cut from main
depot ci dispatch --org 0p91s0lz49 --repo iterate/iterate \
  --workflow preview-os.yml --ref ci-soak/<name> \
  --input pull-request-number=1234 --input action=test
# E2E tests alone, main's suite against main's preview
depot ci dispatch --org 0p91s0lz49 --repo iterate/iterate \
  --workflow preview-os.yml --ref ci-soak/<name> \
  --input preview-name=main --input action=e2e
# Browser specs alone, a branch's specs against a preview by name
depot ci dispatch --org 0p91s0lz49 --repo iterate/iterate \
  --workflow preview-os.yml --ref <branch> \
  --input preview-name=pr1234-my-branch --input action=specs
```

A dispatch posts its checks on its ref's head, replacing that commit's checks of the same name, and
GitHub counts a skipped job as passing. So dispatch one suite alone for a PR from a scratch branch
cut from main ([Run CI without a PR](#run-ci-without-a-pr)): from the PR's branch it would mark the
other suite green, and from `main` it posts on main's head. From the PR's branch, run `test` or
`deploy`. Either way the dispatch updates the suite's line in the PR body and posts the CI trace
statuses on the PR's head. A preview by name may be redeployed under the dispatch by its own
workflow (Main OS e2e for `main`). From a laptop, `pnpm preview e2e` and `pnpm preview specs` do the same
([apps/os/README.md](../apps/os/README.md)). `preview-delete.yml`
(`--input pull-request-number=<pr-number>`) deletes a preview now, `preview-sweep.yml` sweeps now.

Deploy a branch manually:

```bash
depot ci dispatch --org 0p91s0lz49 --repo iterate/iterate \
  --workflow deploy-os.yml \
  --ref <branch> \
  --input ref=<branch>
```

The job runs the deployed ref's own scripts, so a ref from before 2026-09-24 (most rollbacks)
deploys prd and then fails `Check the project hosts`, whose script lacked `--previous-version`.
Check the hosts from `main` by hand: `pnpm tsx scripts/ci/prd-post-deploy-check.ts check --dry-run`.

## Editing Workflows

Edit `.depot/workflows/<name>.yml`, put any real logic in a script under `scripts/ci` (a step is a
one-line `pnpm tsx scripts/ci/<script>.ts …`), and validate with `depot ci run` from a scratch
branch ([Run CI without a PR](#run-ci-without-a-pr)).

- Custom-image jobs declare both `runs-on.size` and `runs-on.image`, and check out with
  `clean: false`.
- Jobs that differ only in a value share one definition through YAML anchors (`&suite-steps`, then
  `*suite-steps`), as the suite jobs of Preview OS and Main OS e2e do, each job's `env` holding
  what differs. Merge keys (`<<:`) are not GitHub Actions syntax, so each job still spells out its
  own `name`, `if` and `env`.
- Independent steps can share a Depot `parallel:` block with `fail-fast: false`.

### Parallel steps

A step inside a `parallel:` block behaves as it would in the list: its `id`,
`if` (`always()`, `hashFiles`), `continue-on-error`, `timeout-minutes`, `env`,
`uses` and `with` all hold. Later steps read its `steps.<id>.outcome` and
outputs, its `$GITHUB_STEP_SUMMARY` lines reach the job's summary, and it shares
`$RUNNER_TEMP` and the workspace. After a failed step, only the block's steps
with `always()` run. The test jobs run their evidence uploads in one such block,
and the report step after the block reads the R2 upload's outcome.

### Reliability defaults

- A credentialed deploy uses one fixed concurrency group named for its destination
  (`deploy-os-production`, never the branch) with `cancel-in-progress: false`: a rollout finishes,
  and Depot keeps the newest pending run behind it.
- Tests and lint/typecheck group by source branch (falling back to `ref_name`) with
  `cancel-in-progress: true`, `main` included.
- Main OS e2e (`main-os-e2e`), the latency guard (`os-latency`) and the real-model suite
  (`os-real-model`) each redeploy one preview, so each has one fixed group with
  `cancel-in-progress: false`: every started run reaches a verdict, and pushes meanwhile collapse
  to the newest pending run.
- Every mainline job has `timeout-minutes`, a watchdog, not a retry: Deploy OS 30 (build, rollout,
  readiness probes, the host check and its Slack notice), the client deploys 15–20.
- No automatic workflow retries: a deploy rerun can repeat external side effects, so an operator
  decides. An attempt that gets a sandbox but no logs or metrics, and passes on rerun, is runner
  provisioning, not an application failure (`depot ci status`, `logs`, `metrics`, `diagnose`).

Runner size follows measured peak CPU and memory. Re-check with `depot ci metrics --run <run-id>`
before changing a size, and the retries too before adding Playwright workers or shards:

| Size   | Jobs                                                                                                                                                | Evidence                                                                                                                                 |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `8x32` | Lint and Typecheck (four checks in parallel), Test                                                                                                  | Test's step 80 s p50 against 87 s on a `4x16`. Watch main's Test for a no-log `Sandbox terminated before worker reported completion`     |
| `4x16` | Deploy OS, Deploy preview, Browser specs (six Playwright workers)                                                                                   | #3258: specs 79/104 s p50/p90 against 96/123 s on a `2x8`; 12+ workers or shards were faster but retried two to four times as many specs |
| `2x8`  | E2E tests (it waits on a remote preview), client deploys, trace jobs, API-only jobs (LOC report, PR dashboard, Release, Health, Main OS e2e's page) | E2E tests peaked at 1.7 vCPUs on a `4x16`, and took 68 s against 62 s there, for half the price                                          |

## Kit firmware releases

Kit Firmware (`kit-firmware.yml`) runs on firmware pull requests and main pushes, daily, and on
dispatch (`devices=all` rebuilds every board after a builder change). Plan picks the boards whose
inputs changed since their newest `kit-firmware/<device>/<version>` release, each builds in its own
`2x8` leg, and Publish, the only job with `contents: write`, creates releases on main from the
legs' artifacts and checks every new file's bytes through `k.iterate.com`. Deploy Kit builds no
firmware. The ESP-IDF pin is in `scripts/depot-ci/esp-idf.sh` and each target's
`dependencies.lock`; the legs run on their own image, `iterate-esp-idf-ci:node24`
(`build-esp-idf-image.yml` bakes it when the script changes on main, and weekly), and
`esp-idf.sh ensure` installs from the network, with a warning, only while the image's receipt and
the script differ. [Kit firmware releases](../apps/kit/README.md#firmware-releases) has the rest.

## Custom Image

`.depot/workflows/build-preview-ci-image.yml` bakes the shared image with
`scripts/depot-ci/bake-preview-ci-image.sh`: Node, pnpm, workspace dependencies, Doppler CLI and the
preview browser, on any sandbox size. It rebuilds when dependency manifests or its bake inputs land
on `main`, and weekly. A push's run bakes nothing when the commit's fingerprint (below) equals the
live image's stamp, since every bake makes the next jobs page in a new image; the schedule and a
dispatch always bake, one at a time per tag. Jobs on the image take their dependencies with
`node scripts/depot-ci/dependencies.mjs install`: an exact
baked fingerprint reuses the installed tree without starting pnpm. A mismatch
or missing receipt runs `pnpm install --frozen-lockfile --prefer-offline`.
Only the Test job always runs that pnpm command, deliberately: the image loads
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
bake script and workflow, verifier, checkout path, Node version, OS/architecture and install
configuration environment. Reuse also checks pnpm's installed metadata and the
workspace module directory listings. New workspace lifecycle scripts disable
reuse; the current root `is-ci || (husky && node scripts/lockfile-stamp.ts)` prepare is a no-op in CI.

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
run and the Preview delete run for the same PR share `preview-os-<pr>`. Only a
push cancels the run in progress (`cancel-in-progress` is true for
`pull_request` alone), whether a push's or a dispatch's run: its verdict would
be out of date, Depot starts none of the cancelled run's `always()` jobs, and
the next run redeploys the whole preview, which repairs a deploy cut short. A
dispatch or a delete cancels nothing, but a newer pending run replaces an older
pending one, so a dispatch queued behind a push can silently disappear. When
validating previews, use one path at a time.

`depot ci logs` accepts a run id, job id, or attempt id. When a run has multiple
jobs, pass `--job <job-key>` or use `depot ci status <run-id> --output json` to
find the exact job/attempt id.

## Which tree a pull request's CI tests

A pull request's Depot run is built from GitHub's test merge commit, `refs/pull/<n>/merge`: the
PR's head merged into main as main stood at the push. `depot ci run show` prints it as `Sha` (the
job's `github.sha`) beside `Head sha`. Depot reads the jobs, steps and env from that merge commit's
workflow files, and registers the `on:` triggers from the default branch
([Trigger Gotchas](#trigger-gotchas)).

So every pull-request job runs the run's own commit, the tree its workflow file came from, never
`head.sha`: main's workflow against the PR's older code fails every PR not rebased past a change
that needs code landing with it (#2999: main's `test.yml` named a workspace the PR heads lacked).
`depot-workflows.test.ts` enforces each checkout:

- Lint and Typecheck, Test, LOC report, the PR dashboard and Kit Firmware's Plan and build legs
  check out `github.sha`. LOC report still diffs the PR's head against its base, from the event.
- Preview OS's deploy passes `github.sha` to `scripts/ci/preview-tested-commit.ts`, which deploys
  it when it is a merge of the head and otherwise resolves `refs/pull/<n>/merge`; e2e and trace
  check out the commit deploy tested. The trace's statuses, the test telemetry's `headSha` and the
  preview's name use the PR head.
- Preview delete checks out `github.sha` on a close: a merged PR's squash commit on main, an
  unmerged PR's head. An unmerged head older than a main change runs the old teardown (#2982's
  close named a renamed Doppler project); the nightly sweep deletes what it leaves.

So a PR's checks cover the PR merged into main at the push: a semantic conflict is a real red. A
retry reruns the same merge commit; push or rebase to test against a newer main. A
`workflow_dispatch` reads its file from the dispatched ref: a Preview OS dispatch from main runs
main's file against the PR merged into main now, and a Preview delete dispatch takes
`refs/pull/<n>/head`.

## Pull requests that conflict with main

GitHub builds no test merge commit for a PR that conflicts with main, and Depot starts no workflow
without one: it records a run with no commit and one failed workflow with no name or jobs (its
error says the merge ref is stale), and the PR shows no Lint and Typecheck, Test or Preview OS
checks at all (#3007 sat with only Bugbot's check until rebased).

The **Merges with main** check (`.github/workflows/merges-with-main.yml`, rules in
`scripts/ci/merges-with-main.ts`) closes that gap. GitHub Actions starts `pull_request_target`
for a conflicted PR, and Depot does not support that event, so this check is a GitHub
Actions workflow. On every push, open and reopen it reads the PR's `mergeable` and:

- fails when it is `false`, with the annotation "This PR conflicts with main, so GitHub builds no
  merge commit for it and Depot runs no CI … Rebase onto main (or merge main in) and push to get
  CI.";
- passes when it is `true`;
- asks again every 5 s while GitHub is still computing it (`null`), and after 12 tries passes with
  a warning that it could not tell;
- passes without deciding when the PR's head has moved on, since that push's run decides.

It runs the base branch's file with a read-only token and never checks out the PR's code. It is not
required (a conflicted PR cannot merge anyway). A PR that main moves under keeps its earlier checks
until its next push.

### A PR and main that both changed the lockfile

Git merges `pnpm-lock.yaml` line by line, so two changes to different lines merge cleanly into a
lockfile pnpm may reject, and a PR's CI tested it against the main of its last push. So
`pnpm-lock.yaml.sha256` holds the lockfile's hash on one line: a PR that changed the lockfile
conflicts with a main whose lockfile changed since its base, and GitHub refuses the merge, whoever
merges it. Rebase, run `pnpm install` (its root `prepare` rewrites the stamp, except where `CI` is
set: then run `node scripts/lockfile-stamp.ts`), commit both files and push; CI then tests the
result. Lint and Typecheck's **Check the lockfile stamp** fails a
commit whose stamp is not its lockfile's hash. The reasons are in `scripts/lockfile-stamp.ts`.

## Which PRs get a preview

Preview OS runs on every pull request with no `paths` filter, because GitHub leaves a required
check "Pending" forever when a `paths` filter skips its workflow. Deploy preview decides instead:
`node scripts/ci/preview-paths.ts changes` diffs the tested merge commit against main and matches
`previewPaths` (`apps/os`, `configs`, the hosted clients but Kit's firmware, `specs` and
`playwright.config.ts`, `packages/cli`, `packages/iterate`, `packages/shared`, `packages/ui`, the
root manifests and lockfile, `envs.ts`, `scripts/lib`, `scripts/depot-ci`, and its own and the
production deploy workflows). A PR that touches none of them gets a green Deploy preview that
deployed nothing and both suites skipped, which GitHub counts as passing. When the step cannot tell,
the PR gets a preview. `preview-delete.yml` runs on the same list;
`scripts/ci/depot-workflows.test.ts` keeps it equal to `previewPaths`.

## Which main pushes deploy

Each `deploy-<app>.yml` runs on a push to `main` that touches what its app ships: the app, the
workspace packages it depends on, `envs.ts`, `scripts/lib` and `pnpm-lock.yaml`, and for OS and the
hosted clients the root `package.json` and `pnpm-workspace.yaml`. `scripts/ci/depot-workflows.test.ts`
pins the exceptions:

- No client deploy runs for `apps/os`: no client imports it.
- Deploy Kit and Deploy Voice run for `packages/agents` and `packages/voice`: their pages run the
  installer (`@iterate-com/voice/install`).
- Deploy OS skips what never reaches the Worker: the markdown at the app root, `apps/os/docs`,
  `apps/os/e2e`, `apps/os/__workers-tests__`, `*.test.ts`, `apps/os/bench`, the preview and soak
  scripts, and `scripts/depot-ci`. Markdown that ships still deploys: `apps/os/public/setup-prompt.md`
  and everything in `configs`. Preview OS and Main OS e2e still run for all of it.
- Deploy SPA ignores the root manifests and lockfile: it has no npm dependency inside.

Each deploy is one job, and every app but SPA, dummy-petshop and ci-reports posts its result to
#ci from its last step.

## Preview job shape

Preview OS runs four jobs, each a check named for what it proves:

- **Deploy preview** deploys the PR merged into main, each step starting once what it needs is
  there ([the trace's spans](ci-traces.md#steps-and-phases)).
- **E2E tests** (`pnpm preview e2e`) and **Browser specs** (`pnpm preview specs`) then run side by
  side, each on its own runner ([reliability defaults](#reliability-defaults)). They are one job
  definition (YAML anchors), each job's env naming its suite (`SUITE`, `FLAKE_SUITE`, the telemetry
  workspace).
- **CI trace** runs after the three, whatever their outcome, and reports only: it writes the two
  suites' lines (their jobs' `status` output) into the PR body, then the trace
  ([Interactive trace reports](#interactive-trace-reports)).

The two suites report on every PR, so a ruleset can require them. Each skips
only when there is nothing for it to prove: a PR that changes no preview path,
or a dispatch of the other suite alone. Where a preview was needed and Deploy
preview did not succeed (failed, cancelled, or a dispatch that named no
preview), each still starts (`always()`), and its first step, "Require a
deployed preview", fails it: red, never a skip that GitHub would count as
passing. `scripts/ci/preview-os-workflow.test.ts` evaluates the conditions
over every case.

Separate jobs cost each suite its own runner start and checkout, in parallel,
and make each one runnable and retryable alone: a red suite runs again without
a redeploy, because the preview persists until the PR closes. Dispatch
`action=e2e` or `specs`, or re-run the run's failed jobs
(`depot ci retry <run-id> --failed --workflow <workflow-id>`): that is the red
suite and the trace job after it, since Depot refuses to retry a job alone
once a job that needs it has started. Main OS e2e has the same jobs by the
same names.

## Main OS e2e keeps one preview

Main OS e2e tests one Worker Preview, `main`, which every run redeploys in place and no run
deletes. The latency guard does the same with `latency`, and the real-model suite with `real-model`
(`CI_WORKFLOW_PREVIEWS` in `apps/os/scripts/preview-sweep.ts`).

A brand-new preview's Durable Objects answer Cloudflare's `internal error; reference = …` for
10–40 s after it is created, and the deploy's readiness gate (`apps/os/scripts/preview-readiness.ts`)
waits that out. A preview redeployed in place has no such window, but it has another: Cloudflare
releases the new version eventually consistently, so for a while an edge can still serve the
previous version and a brand-new Durable Object can still start on it, and an object on it later
resets with "Durable Object reset because its code was updated.", failing every call in flight. So
each of the gate's probes also asks which version its edge and two brand-new contexts run (the
operator's `session.versions`), and the gate passes once three rounds in a row run the deployment
everywhere. The gate starts as soon as `wrangler preview` returns, with no `/version` smoke before
it: the edge's version it asks for is the id `/version` answers with. It fails the deploy after
150 s. A PR's preview, redeployed in place on every push, goes through the same gate.

Soaks of the e2e suite at `--retry=0` (`os-e2e-soak.yml`), every run redeployed in place. With e2e
as soon as a gate without the version check passed, 7 of 48 runs had a row fail on a platform
signature, 30 of their 39 rows "code was updated" (2026-09-24). With the gate held 150 s instead,
the deploy's start to the first test took 173 s at the median (p90 182 s). With the version check
(2026-09-25, 17 runs, before and after the control plane moved to D1) it took 42 s (p90 72 s): stale
rounds held 12 of the 17 gates, for up to 42 s, and every "code was updated" reset landed on a probe
inside a gate. One row failed on a platform signature, a socket dropped 2 s after the gate with no
trace on the Worker's side. With three rounds of two contexts and no `/version` smoke before them
(2026-09-26, 21 in-place and 18 brand-new runs, beside 21 and 19 runs of five rounds of four after
the smoke), `wrangler preview`'s return to the first test took 16.5 s at the median in place (p90
25 s, against 22.8 s and 34 s) and 14.7 s brand-new (p90 21 s, against 19.8 s and 39 s), and no row
failed on a deploy signature (two rows in one brand-new run of the five-round gate). A storage reset
or a dropped socket can still fail a row in any shape, and CI's one retry absorbs it.

- Each workflow's runs are serialized (`cancel-in-progress: false`), so no deploy lands under another
  run's tests.
- Nothing resets the preview before a run. `pnpm preview reset` deletes the preview and creates it
  again, which makes it brand-new. Every row mints its own people and projects, so nothing reads what
  earlier runs left. What they leave accumulates: per e2e run about 40 Artifacts repos, 10 R2
  objects and 100 KV keys, plus the gate's probe contexts.
- The nightly sweep keeps such a preview through quiet days and takes it only once its workflow has
  not deployed it for 7 days (rules 1 and 3 in `preview-sweep.ts`). Deleting one by hand
  (`pnpm preview delete --name main`) makes the workflow's next run brand-new, behind the gate.

## Interactive trace reports

The Preview OS and Main OS e2e workflows end in a CI trace job that posts two commit statuses, **CI
trace** (time to green or red) and **Playwright report**, whose **Details** open the report in the
browser: on a PR's head commit, or main's pushed commit. Re-running a failed suite
(`depot ci retry <run-id> --failed --workflow <workflow-id>`) re-runs the trace job with it; Depot
refuses `--job` for a job whose trace job
has started. A dispatch of `test`, `e2e` or `specs` runs its own trace job. See
[CI traces](./ci-traces.md) for the timing model, the viewer, replay commands
and OTLP JSON export.

## Health

Two jobs page #error-pulse on a change of state, with `scripts/monitors/health.ts`,
each run's pages in one message, each a red or green block with its details and a
link to the run, then the state now of every signal the job pages:

- **main e2e** and **slow e2e rows**: Main OS e2e's own `alert` job, as soon as
  the run's deploy and both suites have ended, from their results and the suite
  summaries E2E tests and Browser specs upload with their flake records. A push
  run only.
- `health.yml`, every hour, judges what the measuring workflows left:
  - **real-model e2e**: the `REAL:` rows of each scheduled or push run of OS
    real model, from its telemetry.
  - **latency**: each new scheduled OS latency report, against the budgets and a
    rolling baseline, red once two runs in a row cross a line.
  - **PR time to green** ([below](#pr-time-to-green)).
  - **DO cost**: the Durable Object cost alarm, in its own daily thread and pages.

  Its message's last line names main e2e's and slow e2e rows' state too, from
  Main OS e2e's state, or none when it cannot read that state.

A red page mentions Jonas once. A page leaves the job green; a check that could
not read Depot, or found its probe broken (a report with no rows, a suite that
did not run), fails the job once the others have paged. Each run since the last
judged is judged, oldest first, so a page names the run where its suite changed
state: Main OS e2e's page job judges its own run after any settled one whose
page was lost. A settled run that Depot ended before its jobs started has no
verdict. A re-run keeps its creation time and is not judged again, so the
next push's run pages it. Each job's memory is its own artifact, `health-state`
and `main-e2e-state`; a state of another `schemaVersion` is not read, and the job
starts over. Dispatch `health.yml` with `--input test-page=true` to post every
one of its checks' verdicts as a 🧪 test page that mentions nobody, keeps no
state and sends PostHog nothing; a run off main without it posts nothing. A
dispatch of Main OS e2e pages nothing.

### PR time to green

The health job reads from Depot how long each pull request push waited for its checks
(`scripts/monitors/ttg.ts`): from the run's creation to the end of the last of Lint and Typecheck,
Test and Preview OS (its last job before the CI trace).

- **Time to green**: the pushes whose checks all passed on their first execution.
- **Time to first verdict**: every push at its first execution's end, so flakes count; a push its
  PR's next push superseded is left out.

Pushes are split by what their E2E tests job ran (the suite summary's `slowRows`): slow rows
skipped, every row, no summary, and no Preview OS. The job log prints each group's p50 and p90 over
24 hours and 7 days, and each push is a PostHog event, `pr checks settled`.

It pages red when the pushes that skipped the slow rows took a p50 over 165 s or a p90 over 200 s
across the last 24 hours, judged from 20 such pushes up; red again whenever that p50 is more than
20 s over the lowest it judged since its last page; and green once both are back under. The lines
hold the owner's rule that a push is green within 3 minutes (`LINES` in the script). Each page
names the job that finished last on most of those pushes (`preview-os.yml:specs`, say).

## Browser reports from artifacts

A report link means the report is available, not that the suite passed: the reports upload even
after test failures. Links use Depot artifact UUIDs and expire
with them. The workflows ask for 30 days, but Depot keeps artifacts about a
week ([test evidence](test-evidence.md) keeps them in R2). Anyone can open an artifact whose name
starts with `public-` at `https://ci-reports.iterate-dev-preview.workers.dev/<artifact-id>/`
([CI traces](./ci-traces.md#the-viewer)), so upload only files intended to be public.

The Browser specs jobs print Playwright's report into the job log, and upload two artifacts even
when the suite fails:

- `public-playwright-report`: the HTML report (`test-results/playwright-html`), which the
  **Playwright report** status opens; a failed spec's trace opens in its trace viewer.
- `preview-os-test-artifacts-attempt-<id>` (main: `main-os-test-artifacts-attempt-<id>`): all of
  `test-results/`, one per job attempt ([above](#artifacts-per-job-attempt)). Each failed spec's
  `trace.zip`, screenshot and `error-context.md` are under `playwright-output/<test>/`.

Fetch either with `depot ci artifacts`, unzip, and open it with
`pnpm exec playwright show-report <dir>` or `pnpm exec playwright show-trace <trace.zip>`.
