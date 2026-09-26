# Depot CI

CI workflows live in `.depot/workflows/*.yml` and run on
[Depot CI](https://depot.dev/docs/ci/overview). The files use GitHub Actions
YAML syntax, but Depot owns the run lifecycle, check reporting, logs, metrics,
secrets, and local dispatch.

Edit the YAML directly, and put runtime logic in normal scripts under `scripts/ci` instead of embedding large
`actions/github-script` blocks.

Workflow-run and job-attempt history (which workflow and job ran for which pull
request, how long it queued and ran, how it ended) goes to PostHog from an
hourly sync; see [CI and test telemetry](ci-test-telemetry.md) for the events,
the sync's window, the Depot organization token and its scope caveat, and
replays.

## Time budget

- A merge to main just deploys: each app's deploy workflow finishes in about two minutes, and
  runs only when the merge touches what that app ships ([Which main pushes deploy](#which-main-pushes-deploy)).
- Main OS e2e (its preview redeployed in place, then e2e) may run in parallel, but nothing waits
  on it ([Main OS e2e keeps one preview](#main-os-e2e-keeps-one-preview)).
- No job sleeps or waits minutes for analytics or logs to settle. Put slow-arriving signals
  (Durable Object cost, prd faults) in a scheduled alarm (`do-duration-probe.yml`,
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
| `main-os-e2e.yml`            | Main push touching the preview paths, dispatch      | **Main OS e2e**: main redeployed in place to preview `main`, E2E tests, Browser specs, trace, alert     |
| `deploy-os.yml`              | Main push touching what OS ships, dispatch          | **Deploy OS**: production, then the project-host check                                                  |
| `deploy-<app>.yml`           | Main push touching what the app ships, dispatch     | Deploy of Dash, Agents, Notes, Voice, Kit, SPA, dummy-petshop or ci-reports                             |
| `kit-firmware.yml`           | Firmware PR and main push, daily, dispatch          | Builds the changed boards; main publishes their releases                                                |
| `build-preview-ci-image.yml` | Main push touching install inputs, weekly, dispatch | Bakes the CI image ([Custom Image](#custom-image)) when the live image's stamp is stale                 |
| `build-esp-idf-image.yml`    | Main push touching `esp-idf.sh`, weekly, dispatch   | Bakes Kit Firmware's legs' image: Node 24 and ESP-IDF ([Kit firmware releases](#kit-firmware-releases)) |
| `do-duration-probe.yml`      | Hourly, dispatch                                    | Durable Object cost alarm for both Cloudflare accounts                                                  |
| `prd-fault-alarm.yml`        | Every 15 minutes, dispatch                          | Reads production's Workers Logs and pages #error-pulse on faults                                        |
| `os-crash-hunt.yml`          | Nightly, dispatch                                   | The opt-in isolate-ceiling rows against production                                                      |
| `os-e2e-soak.yml`            | Dispatch                                            | The e2e suite N times against one deployed worker, each run then the perf budgets                       |
| `os-latency.yml`             | Every 3 hours, dispatch                             | **OS latency**: the perf suite against main's preview `latency`; to PostHog; pages on a change of state |
| `os-real-model.yml`          | Daily, main push to the agents runtime, dispatch    | **OS real model**: the `REAL:` rows against main's preview `real-model`; pages on a change of state     |
| `flake-dashboard.yml`        | Hourly, dispatch                                    | Recomputes [#2580](https://github.com/iterate/iterate/issues/2580) from the flake records in R2         |
| `ci-telemetry.yml`           | Hourly, dispatch                                    | One PostHog event per Depot workflow run and job attempt                                                |
| `pr-ttg.yml`                 | Hourly, dispatch                                    | **PR time to green**: how long each PR push waited for its checks; PostHog; pages when over or worse    |
| `release.yml`                | Daily, dispatch                                     | A dated `v…` release with a changelog when main moved                                                   |
| `shadcn-drift.yml`           | PR touching the vendored shadcn files, dispatch     | **shadcn drift**: fails when a vendored file differs from `shadcn add` (packages/ui/AGENTS.md)          |
| `shadcn-upstream.yml`        | Daily, dispatch                                     | Posts to #ci when shadcn's registry moves past packages/ui's vendored files                             |

Each file's header comment and `on:` block are the details.

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
depot ci diagnose --run <run-id> --org 0p91s0lz49
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

### Artifacts per job attempt

The Test job and the preview and main test jobs name every evidence artifact
after the job attempt that uploaded it: `unit-test-telemetry-attempt-<id>`,
`flake-records-<suite>-attempt-<id>`, `preview-os-test-artifacts-attempt-<id>`
and so on. The job's first step reads `<id>` from `DEPOT_JOB_URL`
(`…?job=<job>&attempt=<id>`), and `depot ci artifacts list` shows the same id
as each artifact's `attempt_id`. A retried job therefore keeps the failed
attempt's telemetry, flake records and Playwright traces beside the retry's.

Never give evidence a fixed name with `overwrite: true`: the retry's upload
deletes every same-named artifact in the run, the failed attempt's included. On 2026-09-24 each of the three retried e2e jobs in the last 431
Test, Preview OS and Main OS e2e runs had lost every artifact from its failed
attempt, and the retried Test job had lost its attempt-1 `flake-records-unit`
(its `unit-test-telemetry`, uploaded without `overwrite`, survived). Without
`overwrite`, a retry of the job alone can collide with the earlier upload and
fail. `scripts/ci/depot-workflows.test.ts` enforces the naming. The one
exception is `public-playwright-report`: its fixed name gives a link to the
latest attempt's report, and every attempt's own copy is in its
`preview-os-test-artifacts-attempt-<id>`.

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
`permissions` instead of a stored bot token. The CI telemetry sync reads its
Depot organization token from `_shared/preview`; the PostHog project key it
sends with is public and comes from `envs.ts`. See
[CI and test telemetry](ci-test-telemetry.md).

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

Agents babysitting a PR: the wait-loop rules (gate on the head commit's
check-runs, Bugbot's check-run and unresolved threads, a push obsoletes every
monitor) are in [Pull requests](pull-requests.md#agent-wait-loops-gate-on-the-head-commits-check-runs).

## Run CI without a PR

Never open a pull request only to run CI, and never run CI on main's commit.
Push a scratch branch and run against its head. `depot ci run` runs any
workflow file, whatever its `on:` (Test has no `workflow_dispatch`).
`depot ci dispatch` runs one that has `workflow_dispatch`, with inputs. Every
check lands on the scratch commit, and no PR body changes unless a Preview OS
dispatch names a PR.

Auth: `depot login`, or the organization token from Doppler:

```bash
export DEPOT_TOKEN="$(doppler secrets get DEPOT_CI_TELEMETRY_TOKEN --plain --project _shared --config preview)"
```

The scratch branch is main plus an empty commit (or the commit to soak), pushed
under its local name:

```bash
git fetch origin main
git worktree add -b ci-soak/<name> ../ci-soak-<name> origin/main
cd ../ci-soak-<name>
git commit --allow-empty -m "ci soak <name>"
git push -u origin HEAD        # also creates the local origin/ci-soak/<name>

depot ci run --org 0p91s0lz49 --workflow .depot/workflows/test.yml
depot ci run --org 0p91s0lz49 --workflow .depot/workflows/lint-typecheck.yml
depot ci dispatch --org 0p91s0lz49 --repo iterate/iterate --workflow os-e2e-soak.yml \
  --ref ci-soak/<name> --input runs=20 --input preview=soak-<name>
```

When done: `git push origin --delete ci-soak/<name>`, remove the worktree, and
delete any preview the soak named (`pnpm --dir apps/os preview delete --name soak-<name>`).

### The commit a run reports on

`depot ci run` diffs the working tree against a base: the local
`origin/<branch>` when it exists, else the merge base with `origin/main`
([depot/cli `findMergeBase`](https://github.com/depot/cli/blob/v2.102.13/pkg/cmd/ci/run.go)).
With no difference the run is `HEAD`; with one, the run is the base commit and
the job applies the difference as a patch. Every check lands on that commit:

- Nothing unpushed or uncommitted on a branch pushed under its own name:
  `HEAD`, and the command prints no `Base:` line.
- Changes on such a branch: `Base: origin/<branch>`, and the pushed commit gets
  the checks. Use this to try a workflow edit without pushing it.
- A branch with no local `origin/<branch>` (unpushed, pushed under another
  name, or a detached `HEAD`): `Base: origin/main`, and the checks land on
  main's commit. Stop and push the branch under its own name. On 2026-09-24
  such a run posted a red Lint and Typecheck on main's head, `a8e6c6525`.
- A clean `main`: main's head, and the job gets `GITHUB_REF=refs/heads/main`
  (run `40b7c4vnsn`). It then shares main's concurrency groups, `test-main`
  and `lint-typecheck-main`, whose `cancel-in-progress` can cancel main's own
  run.

`depot ci dispatch --ref <branch>` runs and reports on the branch's head. With
`--ref main`, that is main's head.

Before a second run, see where the first one's checks went:

```bash
gh api "repos/iterate/iterate/commits/$(git rev-parse HEAD)/check-runs" --jq '.check_runs[].name'
```

GitHub shows the scratch commit's latest check per job name, not one per run,
so count a soak in Depot.

### What the jobs see

Probed on 2026-09-24 from a scratch branch with CLI 2.102.12 and 2.102.13
(runs `xdhdqwvpzg`, `n1vsn3klvq` and `8q19nfxf4n`):

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

A dispatch of `test.yml` fails with `Workflow 'test.yml' not found or does not
have workflow_dispatch trigger`. Preview OS under `ci run` skips every job,
since its jobs need a pull request or a dispatch's inputs: dispatch it. LOC
report under `ci run` prints its table (`No pull request context`) and writes
no body. Downstream a scratch run is an ordinary one: its test evidence goes to
R2 under `trust=pr`, where the flake dashboard reads a Test run's flake records
like a pull request's, and the hourly telemetry sync sends the run to PostHog
with trigger `api` or `workflow_dispatch`. PR time to green reads pull requests
only.

### Soak: N runs, then read them

Test or Lint and Typecheck: N `depot ci run`s side by side. Three Test runs of
one scratch commit (`wxfblqgbr8`, `mdkbdk6tzb`, `whmht81htk`) ran side by side
and each finished in 2 to 2.5 minutes. The e2e suite: `os-e2e-soak.yml`'s `runs` input, not N
dispatches. Preview OS dispatches that name no PR share one concurrency group,
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

# one run: its failure groups, its attempts, then an attempt's log and more
depot ci diagnose --run <run-id> --org 0p91s0lz49
depot ci status <run-id> --org 0p91s0lz49
depot ci logs <attempt-id> --org 0p91s0lz49
depot ci summary <attempt-id> --org 0p91s0lz49      # Test: where its R2 evidence went
depot ci metrics --run <run-id> --org 0p91s0lz49
depot ci artifacts list <run-id> --org 0p91s0lz49   # flake records, telemetry
```

These commands read a `ci run` run as they read any other. The one difference
is that `status` and `artifacts list` name its jobs `_inline_0.yaml:<job>`.

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
  --workflow preview-os.yml \
  --ref <branch> \
  --input pull-request-number=<pr-number> \
  --input action=deploy
```

`action` is `deploy | reset | test | e2e | specs`, `apps` is
`all | auto | none` (the clients on top of the platform preview), and
`slow-rows` is `run | skip` (the e2e rows tagged `slow`; empty follows the PR's
paths and `slow-e2e` label, [slow rows](testing.md#slow-rows)); the header of
`.depot/workflows/preview-os.yml` documents each. `deploy` and `reset` deploy
and then run both suites, as a push does. To run the slow rows against a PR's
live preview: `--input action=e2e --input slow-rows=run`.

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

A dispatch posts its checks on its ref's head commit, replacing that commit's
checks of the same name, and GitHub counts a job it skips as passing. So a
dispatch of one suite from a PR's branch marks the PR's other suite skipped,
green, on the PR's head: dispatch a PR's suite alone from a scratch branch cut
from main ([Run CI without a PR](#run-ci-without-a-pr)), which tests that PR's
tree all the same, and from the PR's branch run `test` or `deploy`. Not from
`--ref main`: that posts the suite's result on main's head. Such a dispatch
(`f6qx3gjvlq`, PR #3090's specs) put its checks on the scratch commit and none
on the PR's head. It still updated the suite's line in the PR body and posted
the CI trace and Playwright report statuses on the PR's head.
A preview by name may be redeployed under the dispatch by its own workflow
(Main OS e2e for `main`). From a laptop, `pnpm preview e2e` and `pnpm preview
specs` do the same ([apps/os/README.md](../apps/os/README.md)).

Deleting a PR's preview
and the nightly preview sweep are workflows of their own: dispatch
`preview-delete.yml` (`--input pull-request-number=<pr-number>`) to delete one
now, `preview-sweep.yml` (no inputs) to sweep now.

Deploy a branch manually:

```bash
depot ci dispatch --org 0p91s0lz49 --repo iterate/iterate \
  --workflow deploy-os.yml \
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
3. Validate the workflow with `depot ci run` from a scratch branch
   ([Run CI without a PR](#run-ci-without-a-pr)).
4. Watch the PR checks in GitHub or with the `watch` commands above.

Prefer small YAML wrappers around scripts. For example:

```yaml
- name: Notify Slack on failure
  run: pnpm tsx scripts/ci/notify.ts workflow-failure
```

Use Depot-specific features where they make the workflow clearer:

- custom-image jobs declare both `runs-on.size` and `runs-on.image`;
- jobs that differ only in a value share one definition through YAML anchors
  (`&suite-steps`, then `*suite-steps`), as the suite jobs of Preview OS and
  Main OS e2e do, each job's `env` holding what differs. Depot CI resolves them
  as GitHub Actions does (run `tf9txcvrp2`). Merge keys (`<<:`) are not GitHub
  Actions syntax, so each job still spells out its own `name`, `if` and `env`;
- `actions/checkout` uses `clean: false` when consuming the baked image;
- independent checks can use Depot `parallel:` blocks with `fail-fast: false`;
- workflow runtime logic belongs in `scripts/ci`, not in long YAML strings.

### Parallel steps

A step inside a `parallel:` block behaves as it would in the list: its `id`,
`if` (`always()`, `hashFiles`), `continue-on-error`, `timeout-minutes`, `env`,
`uses` and `with` all hold. Later steps read its `steps.<id>.outcome` and
outputs, its `$GITHUB_STEP_SUMMARY` lines reach the job's summary, and it shares
`$RUNNER_TEMP` and the workspace. After a failed step, only the block's steps
with `always()` run. Two probe runs on 2026-09-24 showed all of this
(`jtzl92m9nc`, `dzz78f72kg`). The test jobs run their evidence uploads in one
such block, and the report step after the block reads the R2 upload's outcome.

### Reliability defaults

Mainline workflows deliberately separate deployment safety from validation
freshness:

- A credentialed deploy uses one fixed concurrency group named for its actual
  destination, such as `deploy-os-production`. It always sets
  `cancel-in-progress: false`. The checked-out branch is not the destination,
  so it must not appear in that group name. An active rollout finishes; if
  several newer commits queue behind it, Depot keeps the newest pending run.
- Tests and lint/typecheck use the source branch (falling back to
  `ref_name`) and `cancel-in-progress: true`. A newer commit makes an older
  validation result obsolete, including on `main`.
- Main OS e2e is the exception: one fixed group, `main-os-e2e`, with
  `cancel-in-progress: false`. Every run redeploys the one preview `main`, so
  two at once would redeploy it under each other's tests, and every started run
  reaches a verdict. Pushes that land meanwhile collapse to the newest pending
  run. The latency guard (`os-latency.yml`, group `os-latency`, preview
  `latency`) is built the same way for the same reason. So is the real-model suite
  (`os-real-model.yml`, group `os-real-model`, preview `real-model`).
- Every mainline job has `timeout-minutes`. This is a watchdog, not a retry:
  jobs fail at the outer edge and an operator decides whether a rerun is safe.
  Deploy OS gets 30 minutes: its bounded worst case is the build, the rollout,
  the deploy script's readiness probes, the host check (≤ 60 s for `/version`
  to name the new version, then four tries of each production project host)
  and its Slack notice, all in the one job. The client deploys get 15–20.
- Runner size follows observed peak CPU and memory, with headroom. Lint stays
  on `8x32` (parallel oxlint/typecheck/format check/knip). Unit tests use `8x32`
  too: apps/os runs seven vitest slots there, and its test step took 80 s at the
  p50 against 87 s on `4x16` (22 runs each, 2026-09-24; peak 14 % memory, 79 % CPU).
  Two `8x32` sandboxes on one main push have ended the Test job with a no-log
  `Sandbox terminated before worker reported completion` (#1952, #2030, July
  2026; a retry passed), so watch main's Test job for that. Deploy OS uses `4x16`; the client
  deploys (Dash, Agents, Notes, Voice, Kit, SPA, dummy-petshop, ci-reports),
  the trace jobs, Main OS e2e's alert job, and the jobs that only call APIs (LOC report, PR
  dashboard, Release) use `2x8`. So do the E2E tests and Browser specs jobs of Preview OS and
  Main OS e2e, which wait on a remote preview: on `4x16`, 151 attempts on 2026-09-24 peaked at
  1.7 vCPUs and 2.9 GB (E2E tests) and 2.1 vCPUs and 3.2 GB (Browser specs). On `2x8`, ten runs
  of each against one preview took 68 s and 70 s at the p50, against 62 s and 70 s for nine on
  `4x16`, for half the price. Re-check with `depot ci metrics --run <run-id>` before increasing a size.

These defaults keep a normal all-app main push to 42 requested vCPUs (lint 8,
test 8, Deploy OS 4, 2 for each of the seven client deploys, 4 for the preview
parents, and 4 for Main OS e2e, whose deploy job runs first, then its E2E tests
and Browser specs side by side on 2 each; its trace and alert jobs follow
them), without reducing the parallel lint job that
uses the larger machine. The sizing pass that set them cut the then-larger
workflow set from 72 requested vCPUs to 28.

If an attempt receives a sandbox but produces no logs or metrics before
failing, inspect `depot ci status`, `logs`, `metrics`, and `diagnose`. When the
same commit and image pass on rerun, treat that as runner provisioning evidence,
not an application failure. Do not add automatic workflow retries: deployment
reruns can repeat external side effects and need an operator decision.

## Kit firmware releases

Kit Firmware (`kit-firmware.yml`) runs on firmware pull requests and main pushes,
daily at 05:17 UTC, and on dispatch (`devices=all` rebuilds every board after a
builder change). Its Plan job picks the boards whose inputs changed since their
newest `kit-firmware/<device>/<version>` release, and each one builds in its own
2x8 leg. Publish is the workflow's only job with `contents: write`; it checks out
nothing, runs only `gh` and `jq` on the legs' artifacts, and creates releases only
on main, where it then downloads every new file through `k.iterate.com` and
compares the bytes. Deploy Kit builds no firmware. The ESP-IDF pin lives in
`scripts/depot-ci/esp-idf.sh` and in each target's `dependencies.lock`. The legs
run on an image of their own, `iterate-esp-idf-ci:node24`, holding only Node 24
and that ESP-IDF (`build-esp-idf-image.yml` bakes it when the script changes on
main, and weekly), so a leg downloads none of it and the shared image is 3.9 GB
smaller. `esp-idf.sh ensure` checks the image's receipt against the script and
installs from the network, with a warning, only while they differ (a pull
request that changes the script, or main until the image bake that change
triggers finishes). The legs still fetch each target's managed components.
Plan, Publish and the failure notice run on the shared image. Details: [Kit firmware releases](../apps/kit/README.md#firmware-releases).

## Custom Image

The baked image is built by `.depot/workflows/build-preview-ci-image.yml` using
`scripts/depot-ci/bake-preview-ci-image.sh`.

It contains Node, pnpm, workspace dependencies, Doppler CLI and the preview
browser; Kit Firmware's ESP-IDF has an image of its own ([Kit firmware releases](#kit-firmware-releases)). A snapshot is independent of sandbox size: choose `2x8`, `4x16`,
`8x32`, or `16x64` from measured workload demand. Deploy preview runs on `4x16`,
and E2E tests and Browser specs each on a `2x8` of its own.
The image rebuilds when
dependency manifests or its bake inputs land on `main`, with a weekly scheduled
rebuild as drift repair. A push's run first checks the live image on `2x8`:
when the commit's fingerprint (below) equals the image's own stamp, as after a
`package.json` edit outside the install fields or a revert, it bakes nothing,
because every bake leaves the next jobs paging in a new image. The schedule and
a dispatch always bake, and runs for one tag go one at a time, so a push's check
reads the image the bake before it published. Jobs on the image take their dependencies with
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

A pull request's Depot run is built from GitHub's test merge commit, `refs/pull/<n>/merge`:
the PR's head merged into main as main stood when GitHub last built it. `depot ci run show`
prints it as `Sha` (the job's `github.sha`) next to `Head sha`
(`github.event.pull_request.head.sha`). In all 113 pull-request runs on a merge ref between
07:25 and 10:20 UTC on 2026-09-24, `Sha` was a merge commit whose second parent is the run's
`Head sha`. Depot reads the jobs, steps and env of the workflow files from that merge commit;
it registers the `on:` triggers from the default branch ([Trigger Gotchas](#trigger-gotchas)).

So the workflow is main's, and a job that checks out `head.sha` runs it against the PR's own
code, which is as old as the branch. Any workflow change on main that needs code landing with
it (a new script, a new flag, a list of workspaces) then fails every PR not rebased past it,
with nothing wrong in the PR. It happened on 2026-09-24: main's `test.yml` named the new
`@iterate-com/ci-reports` workspace, the heads of #2985, #2986 and #2991 did not have it, and
four Test jobs failed after every test had passed (#2999). Replayed on #2985's run
`q0zxdw71pm`, the workspace check fails in the head `397df9615` and passes in the run's merge
commit `fe85c66d0`.

Every pull-request job therefore runs the run's own commit, the tree its workflow file came from
(`depot-workflows.test.ts` enforces each checkout):

- Lint and Typecheck and Test check out `github.sha`.
- Preview OS's deploy passes `github.sha` to `scripts/ci/preview-tested-commit.ts`, which
  deploys it when it is a merge of the head, and otherwise resolves `refs/pull/<n>/merge` as
  before; e2e and trace check out the commit deploy tested. The trace's statuses, the test
  telemetry's `headSha` and the preview's name still use the PR head.
- LOC report checks out `github.sha`. The report is still the PR's head against its base: the
  script diffs the two shas from the event, and the checkout supplies only the script, its
  dependencies and `.gitattributes`.
- The PR dashboard checks out `github.sha`. Its scripts read GitHub and Slack, never the PR's code.
- Kit Firmware's Plan and build legs check out `github.sha`, so a firmware PR builds what main
  would build after the merge, and a board main changed since the branch point is not rebuilt as
  the PR's change.
- Preview delete checks out `github.sha` on a close. Depot runs a merged PR's close from its
  squash commit on main, the nearest tree to the merge commit Preview OS last deployed: #3016's
  close, run `3ztflxsxzb`, has `Sha` `a1656e2be` (the squash commit) and `Head sha` `495427e19`.
  It runs an unmerged PR's close from its head: `Sha` equals `Head sha` for the closes of #2981,
  #2982, #2996 and #3017.

What that means for a pull request:

- A PR's checks cover the PR merged into main at the time of the push. A semantic conflict with
  main (both sides merge cleanly, the result is broken) is a real red on the PR, as it would be on
  main after merging.
- A retry reruns the same merge commit. To test against a newer main, push (or rebase).
- A PR that conflicts with main has no merge commit and gets no run at all
  ([below](#pull-requests-that-conflict-with-main)).

A `workflow_dispatch` reads its file from the dispatched ref instead: a Preview OS dispatch from
main for a PR runs main's file against that PR merged into main now. A Preview delete dispatch
has no merge to check out and takes `refs/pull/<n>/head`, main's file against the PR's own tree.

The hazard remains where the head is the only tree: an unmerged PR's close runs the head's own
workflow file against the head, so a head older than a main change runs the old teardown. #2982's
close on 2026-09-24 failed `Could not find requested project 'project-worker'`: its head's
`doppler.yaml` still named the Doppler project #2987 had renamed to `os`. The nightly sweep
(`preview-sweep.yml`) deletes what such a close leaves.

## Pull requests that conflict with main

GitHub builds no test merge commit for a PR that conflicts with main, and Depot starts no
workflow without one. It records a run with no commit (`depot ci run list --output json` shows it
with no `sha`) and one failed workflow with no name or jobs, whose error (`depot ci status
<run-id>`) says the merge ref is stale, and the PR shows no Lint and Typecheck, Test or Preview OS
checks: not red, not pending, absent. The CI telemetry sync reports that workflow as a failed run
with no name ([CI and test telemetry](ci-test-telemetry.md)). On 2026-09-24 between 09:23 and
09:59 UTC there were six such runs, for heads of #3004, #3006 and #3007, and each head conflicted
with main at that moment (`git merge-tree`). #3007 sat with only Bugbot's check until it was
rebased.

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

`pull_request_target` runs the base branch's file with a token that can only read, and checks out
only the base branch's script, never the PR's code. The check is not required: a conflicted PR
cannot merge anyway. A PR that main moves under keeps its earlier checks, and its next push gets
the red check.

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

Preview OS (`.depot/workflows/preview-os.yml`, cribbed from cloudflare-os)
runs on every pull request, with no `paths` filter, because its E2E tests and
Browser specs checks are built to be required: GitHub leaves a required check
"Pending" forever when a `paths` filter skips its workflow. Its Deploy preview
job decides instead. Its first step, `node scripts/ci/preview-paths.ts changes`,
diffs the tested merge commit against main and matches `previewPaths`:
`apps/os`, `configs`, the five hosted clients (`apps/dash`, `apps/agents`,
`apps/notes`, `apps/voice`, `apps/kit` but not its firmware), `specs` and
`playwright.config.ts`, `packages/cli` (the e2e drives the built CLI),
`packages/iterate`, `packages/shared`, `packages/ui`, the root manifests and lockfile,
`envs.ts`, `scripts/lib`, `scripts/depot-ci`,
and its own and the six production deploy workflows (OS, Dash, Agents, Notes,
Voice, Kit: a production-workflow change must exercise the isolated
deployment). A PR that touches none of them, such as docs, lint rules or Kit
firmware, gets a green Deploy preview after about 20 s that deployed nothing,
and E2E tests and Browser specs skipped, which GitHub counts as passing. When
the step cannot tell (no merge commit, or main's commit could not be fetched),
the PR gets a preview. The Preview delete workflow
(`.depot/workflows/preview-delete.yml`) runs on the same list when such a PR
closes; `scripts/ci/depot-workflows.test.ts` keeps it equal to `previewPaths`.

## Which main pushes deploy

Each `deploy-<app>.yml` runs on a push to `main` that touches what its app
ships: the app, the workspace packages it depends on, `envs.ts`, `scripts/lib`
and `pnpm-lock.yaml`, and for OS and the five hosted clients the root
`package.json` and `pnpm-workspace.yaml` too. `scripts/ci/depot-workflows.test.ts`
pins the exceptions:

- No client deploy runs for `apps/os`: no client imports it.
- Deploy Kit and Deploy Voice run for `packages/agents` and `packages/voice`:
  their pages run the installer (`@iterate-com/voice/install`).
- Deploy OS skips what never reaches the Worker: the markdown at the app root,
  `apps/os/docs`, `apps/os/e2e`, `apps/os/__workers-tests__`, `*.test.ts`,
  `apps/os/bench`, the preview and soak scripts, and `scripts/depot-ci` (it
  reconciles installs from the frozen lockfile and never changes the bundle).
  Markdown that ships still deploys: `apps/os/public/setup-prompt.md` (prd
  serves it) and everything in `configs` (the build bakes the default
  template's files in). Preview OS and Main OS e2e still run for all of it.
- Deploy SPA ignores the root manifests and lockfile: it ships static files
  and the zipped extension, with no npm dependency inside.

Each deploy is one job. Every app but SPA, dummy-petshop and ci-reports posts to #ci from
that job's last step, with the deploy step's result: a failed, cancelled or
timed-out deploy posts failure.

## Preview job shape

Preview OS runs four jobs, each a check named for what it proves:

- **Deploy preview** deploys the PR merged into main. Inside it, each step
  starts once what it needs is there: the wrangler install, the Previews
  secrets, the Artifacts namespace and the `deploying` status run beside the
  builds, and the clients deploy beside the OS
  ([the trace's spans](ci-traces.md#steps-and-phases)).
- **E2E tests** (the Vitest e2e suite, `pnpm preview e2e`) and **Browser specs**
  (the Playwright specs, `pnpm preview specs`) then start side by side, each on
  a `2x8` runner of its own, so neither shares CPU with the other. They are one
  job definition: Browser specs aliases E2E tests' runner and steps (YAML
  anchors, [Editing Workflows](#editing-workflows)), and each job's env names
  its suite (`SUITE`, `FLAKE_SUITE`, the workspace its telemetry names). The
  Vitest rows tagged `slow` run only when the PR carries the `slow-e2e` label
  or edits one of them ([slow rows](testing.md#slow-rows)).
- **CI trace** runs after the three, whatever their outcome, and reports only
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
each of the gate's probes also asks which version its edge and four brand-new contexts run (the
operator's `session.versions`), and the gate passes once five rounds in a row run the deployment
everywhere. It fails the deploy after 150 s. A PR's preview, redeployed in place on every push, goes
through the same gate.

Soaks of the e2e suite at `--retry=0` (`os-e2e-soak.yml`), every run redeployed in place. With e2e
as soon as a gate without the version check passed, 7 of 48 runs had a row fail on a platform
signature, 30 of their 39 rows "code was updated" (2026-09-24). With the gate held 150 s instead,
the deploy's start to the first test took 173 s at the median (p90 182 s). With the version check
(2026-09-25, 17 runs, before and after the control plane moved to D1) it took 42 s (p90 72 s): stale
rounds held 12 of the 17 gates, for up to 42 s, and every "code was updated" reset landed on a probe
inside a gate. One row failed on a platform signature, a socket dropped 2 s after the gate with no
trace on the Worker's side. A storage reset or a dropped socket can still fail a row in any shape,
and CI's one retry absorbs it.

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

The Preview OS and Main OS e2e workflows' CI trace job runs after the jobs it
needs, whatever their outcome, and posts two commit statuses whose **Details**
open the report in the browser:

- **CI trace**: the time to green or red. The report shows workflow → jobs →
  setup/test phases → shell steps → Playwright attempts and Vitest tests.
- **Playwright report**: the Browser specs job's Playwright HTML report, when
  the suite ran.

A PR's statuses are on its head commit, main's on the pushed commit. Re-running
a failed suite (`depot ci retry <run-id> --failed --workflow <workflow-id>`)
re-runs the trace job with it, which re-collects the trace and re-posts both
statuses at the new uploads; Depot refuses `--job` for a job whose trace job
has started. A dispatch of `test`, `e2e` or `specs` runs its own trace job. See
[CI traces](./ci-traces.md) for the timing model, the viewer, replay commands
and OTLP JSON export.

## PR time to green

`pr-ttg.yml` runs `scripts/ci/pr-ttg-guard.ts` every hour. It reads from
Depot's API how long each pull request push waited for its checks: Lint and
Typecheck, Test, and Preview OS. The wait runs from the run's creation (about
the push) to the end of the last check, Preview OS's at its last job before the
CI trace, which only reports:

- **Time to green**: the pushes whose checks all passed on their first
  execution.
- **Time to first verdict**: every push, red ones and re-run ones at their
  first execution's end, so flakes count. A push whose Test, Lint or Preview
  OS was cancelled because the PR's next push superseded it is left out.

Pushes are split by what their Preview OS E2E tests job ran, which its suite
summary names (`slowRows`, [CI and test telemetry](ci-test-telemetry.md)): slow
rows skipped, every row (including a suite with no row tagged `slow`), no summary
(e2e never ran), and no Preview OS (E2E tests skipped, since the push changed no
preview path). The job log
prints each group's p50 and p90 over the last 24 hours and 7 days, and the
share of Preview OS pushes that ran the slow rows. Each push is a PostHog event,
`pr checks settled`.

The guard pages #error-pulse red when the pushes that skipped the slow rows
took a p50 over 165 s or a p90 over 200 s across the last 24 hours, judged from
20 such pushes up. It pages red again whenever that p50 is more than 20 s over
the lowest it judged since its last page, and green once both are back under.
The lines hold the owner's rule that a push is green within 3 minutes (`LINES`
in the script). Each page names the job that finished last
on most of those pushes, the end of their critical path (`preview-os.yml:specs`,
say); the job log names it for every group. Its state is its own
`pr-ttg-state` artifact; a state of another `schemaVersion` is not read, and
the run starts over. Dispatch it with `--input test-page=true` to post its
numbers as a 🧪 test page that mentions nobody and keeps no state.

The CI trace's time to green ([CI traces](ci-traces.md)) is one workflow's; this
is the push's, across every check.

## Browser reports from artifacts

A browser-readable report is uploaded as a Depot artifact even after test
failures, and the check keeps the actual test outcome: a report link means the
report is available, nothing more. Links use Depot artifact UUIDs and expire
with them. The workflows ask for 30 days, but Depot keeps artifacts about a
week: runs older than that list none ([test evidence](test-evidence.md)). An
artifact whose name starts with `public-` can be opened by anyone at `https://ci-reports.iterate-dev-preview.workers.dev/<artifact-id>/`
([CI traces](./ci-traces.md#the-viewer)), so upload only files intended to be public.

The Preview OS and Main OS e2e Browser specs jobs print Playwright's report
into the job log, and upload two artifacts even when the suite fails:

- `public-playwright-report`: Playwright's HTML report
  (`test-results/playwright-html`), kept about a week. The **Playwright report**
  status opens it; a failed spec's trace opens in the report's trace viewer.
- `preview-os-test-artifacts-attempt-<id>` (main:
  `main-os-test-artifacts-attempt-<id>`): all of `test-results/`, one per job
  attempt ([above](#artifacts-per-job-attempt)). Each failed spec's
  `trace.zip`, screenshot and `error-context.md` are under
  `playwright-output/<test>/`, next to `playwright-results.json`, the
  telemetry and the [test evidence](test-evidence.md) manifest.

Fetch either with `depot ci artifacts` as shown above, unzip, and open it with
`pnpm exec playwright show-report <dir>` or
`pnpm exec playwright show-trace <trace.zip>`. The Test workflow uploads
`unit-test-telemetry-attempt-<id>` and `flake-records-unit-attempt-<id>`; its
[test evidence](test-evidence.md) manifest goes only to R2.
