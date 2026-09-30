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
- Main OS e2e (a fresh deployment of the pushed commit, then e2e) may run in parallel, but nothing
  waits on it ([Main OS e2e deploys each commit fresh](#main-os-e2e-deploys-each-commit-fresh)).
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
- Runners: Depot's stock image, by label, and no image of our own; each job's setup is
  `.depot/actions/setup` and its caches are in Depot Cache
  ([Setup on Depot's stock image](#setup-on-depots-stock-image))
- `DOPPLER_TOKEN` is the only Depot CI secret. Application and service
  credentials live in Doppler; GitHub supplies a short-lived job token.
- Non-secret variables are managed with `depot ci vars`.

Two GitHub Actions workflows are left, both for what Depot cannot do:

- `.github/workflows/pkg-pr-new.yml` is not CI; it publishes the `iterate` SDK, the
  `@iterate-com/cli`, `@iterate-com/petshop-sdk`, `@iterate-com/agents`, `@iterate-com/voice`,
  `@iterate-com/github-sync` and `@iterate-com/ai-linter` packages to
  [pkg.pr.new](https://pkg.pr.new) for every `main` push, and for a PR that changes their inputs
  (their `packages/*` folders, `packages/shared`, the root manifests and lockfile, or the workflow
  itself): the **publish** and **Continuous Releases** checks. Projects install agents, voice, the
  GitHub sync and the AI linter from these builds, and the e2e rows that prove it pin the PR head's.
- `.github/workflows/merges-with-main.yml` is the **Merges with main** check, on
  `pull_request_target`: a PR that conflicts with main gets a red check instead of none
  ([Pull requests that conflict with main](#pull-requests-that-conflict-with-main)).

Anything else that needs GitHub-only triggers, such as `pull_request_target`, `issues`,
`issue_comment`, or PR review comment events, which Depot CI does not support, belongs there too.

## Workflows

| File                  | Runs on                                          | What it does                                                                                                     |
| --------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `lint-typecheck.yml`  | PR, main push, dispatch                          | **Lint and Typecheck** (required): lint, typecheck, format check, knip                                           |
| `test.yml`            | PR, main push, dispatch                          | **Test** (required): `pnpm test`, and beside it the Kit firmware host tests                                      |
| `loc-report.yml`      | PR, dispatch                                     | The LOC table in the PR body                                                                                     |
| `pr-dashboard.yml`    | PR opened, reopened, ready, drafted or closed    | The event's line in #ci and the daily PR dashboard                                                               |
| `preview-os.yml`      | Every PR, dispatch                               | **Preview OS**: Deploy preview, beside it **E2E tests** and **Browser specs** in shards, then CI trace           |
| `preview-delete.yml`  | Such a PR closing, dispatch                      | Deletes the PR's deployments                                                                                     |
| `preview-sweep.yml`   | Nightly, dispatch                                | Deletes superseded, stale and half-made deployments                                                              |
| `main-os-e2e.yml`     | Main push touching the preview paths, dispatch   | **Main OS e2e**: the pushed commit deployed as `main-<sha7>`, E2E tests, Browser specs, cleanup, its page, trace |
| `deploy-os.yml`       | Main push touching what OS ships, dispatch       | **Deploy OS**: production, then the project-host check                                                           |
| `deploy-<app>.yml`    | Main push touching what the app ships, dispatch  | Deploy of Dash, Agents, Notes, Docs, Voice, Kit, SPA, dummy-petshop or ci-reports                                |
| `kit-firmware.yml`    | Firmware PR and main push, daily, dispatch       | Builds the changed boards; main publishes their releases                                                         |
| `prd-fault-alarm.yml` | Every 15 minutes, dispatch                       | Reads production's Workers Logs and pages #error-pulse on faults                                                 |
| `health.yml`          | Hourly, dispatch                                 | **Health**: judges the runs below and PR time to green; one #error-pulse page per red signal                     |
| `os-crash-hunt.yml`   | Nightly, dispatch                                | The opt-in isolate-ceiling rows against production                                                               |
| `context-sweep.yml`   | Nightly, dispatch                                | Backs up and destroys production's orphan contexts (`scripts/ci/context-sweep.ts`)                               |
| `os-e2e-soak.yml`     | Dispatch                                         | The e2e suite N times against one deployed worker, each run then the perf budgets                                |
| `os-latency.yml`      | Every 3 hours, dispatch                          | **OS latency**: the perf suite against main's commit deployed as `latency-<sha7>`, its report for the health job |
| `os-real-model.yml`   | Daily, main push to the agents runtime, dispatch | **OS real model**: the `REAL:` rows against main's commit deployed as `real-model-<sha7>`, for the health job    |
| `flake-dashboard.yml` | Hourly, dispatch                                 | Recomputes [#2580](https://github.com/iterate/iterate/issues/2580) from the flake records in R2                  |
| `ci-telemetry.yml`    | Hourly, dispatch                                 | One PostHog event per Depot workflow run and job attempt                                                         |
| `release.yml`         | Daily, dispatch                                  | A dated `v…` release with a changelog when main moved                                                            |
| `shadcn-drift.yml`    | PR touching the vendored shadcn files, dispatch  | **shadcn drift**: fails when a vendored file differs from `shadcn add` (packages/ui/AGENTS.md)                   |

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
after the job attempt that uploaded it: `<unit|preview-os|main-os>-test-artifacts-attempt-<id>`,
the job's whole `test-results/`, its flake records and suite summary under
`flake-records/<suite>/`. The job's first step reads `<id>` from `DEPOT_JOB_URL`
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

A step hands its script `DOPPLER_TOKEN` and nothing else from Doppler, and the script reads what it
needs itself, through `scripts/lib/env-context.ts`: `resolveEnvContext` for an envs.ts deployment
(the deploys, the context sweep, erase and seed), `dopplerSecret(project, config, name)` for one
secret (the Depot organization token, `scripts/ci/depot.ts` `depotApi`; the Slack bot token,
`scripts/ci/slack.ts`; an account's Cloudflare API token, envs.ts `cloudflareAccounts`). No step
reads a secret into its shell. The one other form is for commands that act on an OS deployment
with its configuration in their environment, as a developer's terminal runs them: the preview
tooling (`pnpm preview …`) and the suites against a deployment (`pnpm e2e`, `pnpm e2e:run`,
`pnpm os:e2e-soak`, `pnpm perf:run`) run under
`doppler run --project os --config <the deployment's config> --`. `depot-workflows.test.ts` fails a
step that calls Doppler any other way. The test evidence upload's token
is fetched beside the tests into a Doppler fallback file and read offline after them
([test evidence](test-evidence.md#what-ci-does)).

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
`depot ci run` runs any workflow file, whatever its `on:`; `depot ci dispatch` runs one that has
`workflow_dispatch`, with inputs. Only a dispatch reaches Depot Cache, so soak by dispatch: under
`ci run` every restore misses, and a job installs from the npm registry. Auth:
`depot login`, or the organization token from Doppler:

```bash
export DEPOT_TOKEN="$(doppler secrets get DEPOT_CI_TELEMETRY_TOKEN --plain --project _shared --config preview)"

git fetch origin main
git worktree add -b ci-soak/<name> ../ci-soak-<name> origin/main
cd ../ci-soak-<name>
git commit --allow-empty -m "ci soak <name>"
git push -u origin HEAD        # also creates the local origin/ci-soak/<name>

depot ci dispatch --org 0p91s0lz49 --repo iterate/iterate --workflow test.yml --ref ci-soak/<name>
depot ci run --org 0p91s0lz49 --workflow .depot/workflows/lint-typecheck.yml
depot ci dispatch --org 0p91s0lz49 --repo iterate/iterate --workflow os-e2e-soak.yml \
  --ref ci-soak/<name> --input runs=20 --input preview=soak-<name>
depot ci run --org 0p91s0lz49 --workflow .depot/workflows/test.yml --job test --ssh   # debug one job
```

When done: `git push origin --delete ci-soak/<name>`, remove the worktree, and delete any preview
the soak named (`pnpm preview delete --name soak-<name>`).

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
- A clean `main`: main's head with `GITHUB_REF=refs/heads/main`, sharing main's branch-named
  concurrency groups, so it can cancel main's own run of a workflow grouped by branch (not Test's or
  Lint's: a push to main groups by its sha).

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

Lint and Typecheck: N `depot ci run`s side by side. Test: dispatches, one run per branch at a time,
since each cancels the one before it; for runs side by side, push several soak branches. The e2e
suite: `os-e2e-soak.yml`'s `runs` input, not N dispatches. Preview OS dispatches that name no PR
share one concurrency group, `preview-os-none`, where a newer pending run replaces an older one.

```bash
for i in $(seq 10); do
  depot ci run --org 0p91s0lz49 --workflow .depot/workflows/lint-typecheck.yml | awk '/^Run:/ {print $2}'
done | tee soak-runs.txt

# Test: one at a time. Dispatch the next once `depot ci status` says the last one finished.
depot ci dispatch --org 0p91s0lz49 --repo iterate/iterate --workflow test.yml --ref ci-soak/<name>

# the tally; --name takes the workflow's name: ("Test"). Rerun until none is queued or running.
depot ci workflow list --org 0p91s0lz49 --repo iterate/iterate --name "Lint and Typecheck" \
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

Deploy a branch manually, or roll back by pushing a branch at the old commit first:

```bash
git push origin <commit>:refs/heads/rollback/<name>   # a rollback only
depot ci dispatch --org 0p91s0lz49 --repo iterate/iterate \
  --workflow deploy-os.yml --ref <branch>
```

The deploy checks out the commit it was dispatched at, and runs that commit's own workflow, setup
and scripts.

## Editing Workflows

Edit `.depot/workflows/<name>.yml`, put any real logic in a script under `scripts/ci` (a step is a
one-line `node scripts/ci/<script>.ts …`), and validate with `depot ci run` from a scratch
branch ([Run CI without a PR](#run-ci-without-a-pr)).

- A step runs TypeScript one way: `node <file>.ts`, with Node's own type stripping (the root
  `tsconfig.base.json` allows only erasable syntax). A trpc-cli script ends with
  `createCli({ ...import.meta })` ([scripts are trpc-cli programs](typescript-conventions.md#scripts-are-trpc-cli-programs)),
  so `node` runs its commands. Steps that run before `pnpm install` use the same form.
  `depot-workflows.test.ts` fails a step that calls `tsx` or the trpc-cli bin, which the root does
  not install.
- Every job runs on a stock label and, after its checkout, `uses: ./.depot/actions/setup`
  ([Setup on Depot's stock image](#setup-on-depots-stock-image)).
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
with `always()` run. The Test job runs Kit's firmware host tests and the evidence
upload's token fetch beside `pnpm test` in one such block, and the test jobs run their evidence uploads in another; the
report step after that block reads the R2 upload's outcome.

A condition that calls `hashFiles()` costs the runner about 0.2 s, the job's first
one about 0.6 s, and a block's conditions are evaluated one at a time before its
steps start: on a `2x8`, a block of three steps each with `hashFiles()`
started its first command 0.63 s after the step before, against 0.1 s with plain
conditions (probe runs `l0k2xd618v`, `prqd1q8n48`, `8d2zn6gshd`, 2026-09-27). The
test jobs' evidence steps read the finalizer step's outputs instead
([test evidence](test-evidence.md#what-ci-does)).

### Reliability defaults

- A credentialed deploy uses one fixed concurrency group named for its destination
  (`deploy-os-production`, never the branch) with `cancel-in-progress: false`: a rollout finishes,
  and Depot keeps the newest pending run behind it.
- Tests and lint/typecheck group by source branch (falling back to `ref_name`) with
  `cancel-in-progress: true`, except a push to `main`, whose group is its sha: every merge commit
  gets its own Test and Lint verdict, since one shared group cancels the run in progress or
  replaces the pending one.
- Main OS e2e groups by commit (`main-os-e2e-<sha>`) with `cancel-in-progress: false`: every main
  commit gets its own run and verdict, and runs of different commits overlap, each on its own
  deployment ([Main OS e2e deploys each commit fresh](#main-os-e2e-deploys-each-commit-fresh)).
- The latency guard (`os-latency`) and the real-model suite (`os-real-model`) each have one fixed
  group with `cancel-in-progress: false`: every started run reaches a verdict, and runs triggered
  meanwhile collapse to the newest pending run.
- Every mainline job has `timeout-minutes`, a watchdog, not a retry: Deploy OS 30 (build, rollout,
  readiness probes, the host check and its Slack notice), the client deploys 15–20.
- No automatic workflow retries: a deploy rerun can repeat external side effects, so an operator
  decides. An attempt that gets a sandbox but no logs or metrics, and passes on rerun, is runner
  provisioning, not an application failure (`depot ci status`, `logs`, `metrics`, `diagnose`).

Runner size follows measured peak CPU and memory. Re-check with `depot ci metrics --run <run-id>`
before changing a size, and the retries too before adding Playwright workers or shards:

| Size (label)                    | Jobs                                                                                                                                                | Evidence                                                                                                                                                                                                                                                                                                              |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `8x32` (`depot-ubuntu-24.04-8`) | Lint and Typecheck (four checks in parallel), Test, Deploy preview (seven client builds side by side)                                               | Test's step 80 s p50 against 87 s on a `4x16`. Watch main's Test for a no-log `Sandbox terminated before worker reported completion`. Deploy preview's builds take 5–7 s against 9–12 s on a `4x16`, and it reaches the readiness gate 21.6/24.6 s p50/p90 after it starts against 25.3/28.4 s (n=5 each, 2026-09-27) |
| `4x16` (`depot-ubuntu-24.04-4`) | Deploy OS, each Browser specs shard (six Playwright workers), Kit Firmware's legs                                                                   | #3258: specs 79/104 s p50/p90 against 96/123 s on a `2x8`; 12+ workers or shards were faster but retried two to four times as many specs                                                                                                                                                                              |
| `2x8` (`depot-ubuntu-24.04`)    | E2E tests (it waits on a remote preview), client deploys, trace jobs, API-only jobs (LOC report, PR dashboard, Release, Health, Main OS e2e's page) | E2E tests peaked at 1.7 vCPUs on a `4x16`, and took 68 s against 62 s there, for half the price                                                                                                                                                                                                                       |

## Kit firmware releases

Kit Firmware (`kit-firmware.yml`) runs on firmware pull requests and main pushes, daily, and on
dispatch (`devices=all` rebuilds every board after a builder change). Plan picks the boards whose
inputs changed since their newest `kit-firmware/<device>/<version>` release, each builds in its own
`4x16` leg, and Publish, the only job with `contents: write`, creates releases on main from the
legs' artifacts and checks every new file's bytes through `k.iterate.com`. Deploy Kit builds no
firmware. The ESP-IDF pin is in `scripts/ci/esp-idf.sh` and each target's `dependencies.lock`. A
leg restores that pin's ESP-IDF, for the image's python3, from [Depot Cache](#depot-cache), and
`esp-idf.sh ensure` installs from the network, with a warning, only when there was none, after which
a main leg saves it. On a 4x16 a leg restores its 1.06 GB in 7 s and builds a board in 30 s, against
12–27 s and 48–52 s on a 2x8, for about the same cost.
[Kit firmware releases](../apps/kit/README.md#firmware-releases) has the rest.

## Setup on Depot's stock image

Every job runs on Depot's stock image, by its label (`depot-ubuntu-24.04`, `-4`, `-8`), and we
build no image of our own. Every Depot customer runs the stock image, so it boots warm on any host,
and the files a job installs itself are in the page cache when it reads them. Our own image, gone
since 2026-09-27, loaded lazily from Depot's storage: 22–42 % of jobs booted it cold, and the work
then paged the baked tree in, so the suites took 9–11 s from job start to their first test at the
p50 and 31–44 s at the p90.

After its checkout, a job runs `uses: ./.depot/actions/setup`, whose steps run one after another
(Depot never runs a `parallel:` block inside a composite action):

1. **Start the toolchain** (`scripts/ci/toolchain.sh start`): Node at `.nvmrc`'s version from the
   stock image's tool cache, `/opt/hostedtoolcache/node` (setup-node never reads it: Depot points
   it at an empty one), else from nodejs.org with a warning. Then, in the background while the store
   restores, pnpm from the root `packageManager` by corepack, and the Doppler CLI release the script
   pins, checked against its SHA-256.
2. **Restore pnpm's store** from [Depot Cache](#depot-cache).
3. **Install dependencies**: waits for the toolchain, then
   `pnpm install --frozen-lockfile --prefer-offline`.

A job's workspace is installed 7–8 s after it starts on a 4x16 or an 8x32, 9 s on a 2x8. Kit
Firmware's jobs install nothing and run `scripts/ci/toolchain.sh node`. Preview OS's two scripts
that choose the tested commit (`preview-tested-commit.ts`, `preview-paths.ts`) run before the setup
on the stock image's own Node 22, with nothing but Node's builtins, since the PR head they start
from may predate the setup. The store is `NPM_CONFIG_STORE_DIR=/home/runner/.pnpm-store` (pnpm 10
reads `npm_config_*`, not `pnpm_config_*`), and `NPM_CONFIG_SIDE_EFFECTS_CACHE=false` keeps build
outputs out of it: the install runs the few build scripts itself, since from a store that held
their outputs it took 5 s longer. No job runs `doppler setup`: every Doppler read names its
project and config.

### Depot Cache

`actions/cache` is Depot Cache on Depot CI, whose entries expire after 14 days:

| Entry                               | Key                                                                              | Restored by                                                        | Saved by                                          |
| ----------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------- |
| pnpm's store, 247 MB                | `pnpm-store-` and the hash of the lockfile, `pnpm-workspace.yaml` and `patches/` | the setup, in every job but the production deploys and the release | Test, on a main push that missed its key          |
| Playwright's headless shell, 103 MB | `ms-playwright-` and the lockfile's hash                                         | each specs shard, beside its setup                                 | Main OS e2e's first shard, on a push that missed  |
| ESP-IDF and its tools, 1.06 GB      | `esp-idf-`, the hash of `scripts/ci/esp-idf.sh` (the pin) and python3's version  | Kit Firmware's legs                                                | a main leg that missed, right after installing it |

Off main a restore falls back to the newest entry of its kind (`restore-keys`), except ESP-IDF's:
an older pin's is of no use, nor is one whose Python environment was built for another python3.
Main restores the exact key alone, so what main saves holds only its own lockfile's packages:
`pnpm store prune` cannot cut an older store down, since it drops every file with one link, and
pnpm copies the packages it builds. A restore that fails or times out is a
warning, and the job fetches what it lacks: from the npm registry, from Playwright's CDN (the
suite's `playwright install --only-shell`), or from GitHub, dl.espressif.com and PyPI
(`esp-idf.sh ensure`, with its own warning). Test's summary says which store its install started
from and whether main saved one, and warns on a failed restore or save
(`scripts/ci/pnpm-store-report.sh`). actions/cache reports most other trouble only in its own log:
a restore that could not read Depot Cache reads as none restored.

Depot Cache has no branch scope: any run can write any key, and main's next key follows from an
open pull request's lockfile, so a pull request could plant a store for main's runs by editing a
workflow. So only main writes it, and no job that ships to production reads it: the `deploy-*.yml`
workflows and `release.yml` install from the npm registry (`pnpm-store: none`), whose lockfile
hashes vouch for every package, about 5 s more on a 2x8 and 3 s on a 4x16. Every workflow that
reads it holds a read-only `contents` token. Kit Firmware's legs on main, which build the release
firmware, read the exact ESP-IDF key: the same exposure as the image they booted before, whose tag
a pull request's workflow could as well have pushed. Today a planted entry reaches nothing its
author's own run does not already have, because Depot CI runs no pull request from a fork, so every
run is from someone who can push here, with the one `DOPPLER_TOKEN`, which also reads
`_shared/preview` (the Depot organization token, the preview Cloudflare API token).
iterate/iterate is public, and Depot plans fork support
([compatibility](https://depot.dev/docs/ci/compatibility)). Before fork pull requests run on
Depot, scope or drop the cache and the pull requests' `restore-keys` fallbacks. Otherwise a fork's
pull request, which gets no secrets, could plant an entry that main or another pull request then
runs with that token. pnpm checks each file it links against the store's index
(`verify-store-integrity`, on by default), which catches a damaged store, not a planted one.
`scripts/ci/depot-workflows.test.ts` pins all of this.

So every job depends on GitHub (the checkout, the Doppler CLI), the npm registry (pnpm by corepack,
and packages on a miss) and Depot Cache.

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
the next run deploys a deployment of its own, whatever the cancelled one left. A
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
  it when it is a merge of the head and otherwise resolves `refs/pull/<n>/merge`. The suites start
  beside the deploy, so they find its commit themselves, by the deploy's own two steps: the PR's
  head, then the same `preview-tested-commit.ts` with the same `github.sha`. The trace checks out
  the commit deploy tested. The trace's statuses, the test telemetry's `headSha` and the preview's
  name use the PR head.
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
root manifests and lockfile, `envs.ts`, `scripts/lib`, the setup (`.depot/actions`,
`scripts/ci/toolchain.sh`), and its own and the production deploy workflows). A PR that touches
none of them gets a green Deploy preview that deployed nothing, and two green suites that tested
nothing: each runs the same step on the same commit and passes once it says so
([preview job shape](#preview-job-shape)). When the step cannot tell, the PR gets a preview.
`preview-delete.yml` runs on the same list;
`scripts/ci/depot-workflows.test.ts` keeps it equal to `previewPaths`.

## Which main pushes deploy

Each `deploy-<app>.yml` runs on a push to `main` that touches what its app ships: the app, the
workspace packages it depends on, `envs.ts`, `scripts/lib` and `pnpm-lock.yaml`, and for OS and the
hosted clients the root `package.json` and `pnpm-workspace.yaml`. `scripts/ci/depot-workflows.test.ts`
pins the exceptions:

- No client deploy runs for `apps/os`: no client imports it.
- Deploy Kit and Deploy Voice run for `packages/voice`: their pages run its voice check
  (`@iterate-com/voice/install`).
- Deploy OS skips what never reaches the Worker: the markdown at the app root, `apps/os/docs`,
  `apps/os/e2e`, `apps/os/__workers-tests__`, `*.test.ts`, `apps/os/bench`, and the preview and
  soak scripts. Markdown that ships still deploys: `apps/os/public/setup-prompt.md`
  and everything in `configs`. Preview OS and Main OS e2e still run for all of it.
- Deploy SPA ignores the root manifests and lockfile: it has no npm dependency inside.

Each deploy is one job, and every app but SPA, dummy-petshop and ci-reports posts its result to
#ci from its last step.

## Preview job shape

Preview OS runs these jobs, each a check named for what it proves:

- **Deploy preview** deploys the PR merged into main, each step starting once what it needs is
  there ([the trace's spans](ci-traces.md#steps)).
- **E2E tests** (`pnpm preview e2e`) and **Browser specs** (`pnpm preview specs`) start with the
  run, beside Deploy preview, each on its own runner ([reliability defaults](#reliability-defaults)).
  Each sets its suite up while the preview deploys, then waits for the deploy
  ([suites start with the run](#suites-start-with-the-run)). They are one job definition (YAML
  anchors), each job's env naming its suite (`SUITE`, `FLAKE_SUITE`, the telemetry workspace).
  The specs run [in shards](#browser-specs-in-shards), **Browser specs 1/11** to **11/11**, and
  **Browser specs** beside them gives their verdict.
- **CI trace** runs after the deploy and the suites' jobs, whatever their outcome, and reports
  only: it writes the two suites' lines (their jobs' `status` output) into the PR body, then the
  trace ([Interactive trace reports](#interactive-trace-reports)).

The two suites report on every PR, so a ruleset can require them. Each is
skipped only on a dispatch of the other suite alone. On a PR that changes no
preview path, each decides so as Deploy preview does
(`node scripts/ci/preview-paths.ts changes`, on the same commit) and passes,
having tested nothing. Where a preview was needed and there is none, each fails:
red, never a skip that GitHub would count as passing. Its wait fails it when
Deploy preview failed or was cancelled, and its step "Require a preview to test"
when a dispatch names no preview. `scripts/ci/preview-os-workflow.test.ts`
evaluates the conditions over every case.

Separate jobs cost each suite its own runner start and checkout, in parallel,
and make each one runnable and retryable alone: a red suite runs again without
a redeploy, because the preview persists until the PR closes. Dispatch
`action=e2e` or `specs`, or re-run the run's failed jobs
(`depot ci retry <run-id> --failed --workflow <workflow-id>`): that is the red
suite and the trace job after it, since Depot refuses to retry a job alone
once a job that needs it has started. Main OS e2e has the same jobs by the
same names.

### Browser specs in shards

With Playwright's full parallelism a spec starts as soon as a worker is free, so when
`shards × workers ≥ specs` every spec starts at once and the suite takes about as long as its
longest spec. Each shard is a `4x16` with six workers (the density #3258 measured), so there are
`ceil(specs / 6)` shards: 10 for 58 specs. `scripts/ci/specs-shards.test.ts` lists the specs and
fails when the count no longer matches, naming what to change: `SPECS_SHARDS` and the
`specs-shard` matrix, in both workflows. Playwright 1.63 deals the specs out by count, so the
fullest shard holds `ceil(specs / shards)`.

- The shards are the legs of the matrix job `specs-shard`, **Browser specs 1/11** to **11/11**.
  Each sets up and waits for the deploy like any suite job, then runs its share (`SPECS_SHARD` of
  `SPECS_SHARDS`, playwright.config.ts `shard`), and keeps its own evidence, with a Playwright
  blob report in place of the HTML one.
- **Browser specs** (`specs`, the required check) runs no spec. It starts with the run on the
  smallest runner, decides whether there is a preview to test by the suites' own steps, and
  waits for every shard to settle. Then it downloads each shard's blob report from its newest
  attempt's test results, merges them into the one HTML report behind the **Playwright report**
  status, and fails when a shard did not pass (`scripts/ci/specs-shards.ts`). So it is green only
  when every spec passed. With `needs:` it would boot and set up only after the last shard; this
  way its verdict comes about a second after it. In the CI trace the shards sit under its row,
  below its own steps in one **Coordinate shards** row, where its wait for them is nearly all.
- Cost: every shard waits out the deploy on its own `4x16`, and Browser specs on a `2x8`. More
  workers against one preview have raised retries before (#3258), so compare the retried specs per
  run before and after changing the count.

### Suites start with the run

A suite job with `needs: deploy` would start only once the deploy ended, so
Depot's hand-off (about 3 s), the sandbox's boot (about 2 s), the checkout and
setup (about 7 s), Node loading
`scripts/os/preview.ts` and the test runner's start would all come between
the deploy's end and the first test. So the suites of Preview OS and Main OS e2e
have no `needs:`. Each starts with the run and, while the preview deploys:

1. checks out the commit Deploy preview deploys, by the deploy's own two steps:
   the PR's head, then the PR merged into main by
   `scripts/ci/preview-tested-commit.ts` (on a push the run's own commit when it
   merges this head, else the merge GitHub rebuilt), and on a push decides
   whether the PR changes a preview path. The deployment it tests is
   `<prefix>-<sha7>` of that commit, the name Deploy preview gives it;
2. runs the setup ([Setup on Depot's stock image](#setup-on-depots-stock-image)),
   beside it for the specs Playwright's headless shell from Depot Cache, and starts
   its suite step, whose `runSuite` chooses the slow rows and installs Chromium's
   headless shell when the restore did not. Beside them the specs run
   `playwright test --list`, which reaches no preview and fills Playwright's
   transform cache with every spec compiled. If it is still running when the
   deploy ends, it is stopped, and exits beside the suite's start rather than
   before it;
3. polls Depot's GetWorkflow once a second for its own run's `deploy` job
   (`scripts/ci/await-deploy.ts`, which `PREVIEW_AWAIT_DEPLOY_JOB` turns on), and
   starts the suite once that job has finished. One that failed, was cancelled or
   skipped fails the suite: "Deploy preview failed, so there is no preview of
   this commit to test." The wait reads the job's status, not an attempt's, so a
   suite re-run alone after its run ended goes at once, and one re-run beside a
   failed deploy waits for the deploy's next attempt. It logs each change of the
   deploy's state and gives up after the deploy's own 40-minute timeout. Depot
   failing on its own side (a 5xx, a 429, a lost connection) fails no suite: each
   call is asked again on `CI_HTTP`'s schedule, then the wait warns and asks
   again a second later, and only five minutes in which every call failed end
   it. A 401 or 403, a missing token or an answer it cannot read fail it at once.
   The suite then runs for at most 30 minutes (`runBounded` stops its process
   group), so the suite jobs' timeout is 70 minutes: the wait, then the suite's 30.

A suite keeps its evidence once it read its deployed target
(`test-results/target.json`, [test evidence](test-evidence.md)), so a job that
never had a preview keeps none. A target it cannot write fails the job before
the suite, so no suite passes with its evidence unchecked. Each suite's runner
waits out the deploy, less its own set-up: about 45 s each, so a push bills
about 90 s more between the two, about $0.013 (25 runs each way). In return
the first test follows the deploy's end by 3.9 s (E2E tests) and 2.1 s
(Browser specs) at the median, against 16 and 13 s with `needs: deploy`.

## Main OS e2e deploys each commit fresh

Main OS e2e deploys each pushed commit as a deployment of its own, `main-<sha7>` (apps/os and every
app on top, envs.ts `previewDeployment`), tests it, and deletes the `main-…` deployments before it
(Clean up superseded). The latency guard does the same under `latency`, and the real-model suite
under `real-model` (`CI_WORKFLOW_PREVIEWS` in `scripts/os/preview-sweep.ts`); when main has not
moved since their last run, they deploy the same deployment again, in place.

A brand-new worker's Durable Objects can answer Cloudflare's `internal error; reference = …` for
seconds after it is created (10–40 s on brand-new Worker Previews, 2026-09), and the deploy's
readiness gate (`scripts/os/preview-readiness.ts`) waits that out. A worker redeployed in place
has another window: Cloudflare releases the new version eventually consistently, so for a while an
edge can still serve the previous version and a brand-new Durable Object can still start on it, and
an object on it later resets with "Durable Object reset because its code was updated.", failing
every call in flight. So each of the gate's probes also asks which version its edge and two
brand-new contexts run (the operator's `session.versions`), and the gate passes once three rounds in
a row run the deployment everywhere. It fails the deploy after 150 s. Every deployment goes through
the same gate; only a same-commit redeploy and main on dev meet the in-place window now.

Soaks of the e2e suite at `--retry=0` (`os-e2e-soak.yml`), every run redeployed in place. With e2e
as soon as a gate without the version check passed, 7 of 48 runs had a row fail on a platform
signature, 30 of their 39 rows "code was updated" (2026-09-24). With the version check (2026-09-25,
17 runs) the deploy's start to the first test took 42 s at the median (p90 72 s), and every "code
was updated" reset landed on a probe inside a gate. With three rounds of two contexts and no
`/version` smoke before them (2026-09-26, 21 in-place and 18 brand-new runs, beside 21 and 19 runs
of five rounds of four after the smoke), `wrangler preview`'s return to the first test took 16.5 s
at the median in place (p90 25 s, against 22.8 s and 34 s) and 14.7 s brand-new (p90 21 s, against
19.8 s and 39 s), and no row failed on a deploy signature. A storage reset or a dropped socket can
still fail a row in any shape, and CI's one retry absorbs it.

- Every main commit gets its own Main OS e2e run, and runs of different commits overlap. A run's
  cleanup deletes only the deployments created before its own, and none that a run still in progress
  tests (Depot's queued and running runs of the workflow, `cleanup-superseded`), so an older commit's
  run keeps its deployment until it ends; a later run's cleanup or the nightly sweep takes it then.
  The latency guard's and the real-model suite's runs are serialized, one at a time.
- The runs' page jobs take turns, oldest run first: each waits until the older push runs have
  ended ([Health](#health)).
- Every row mints its own people and projects, so nothing reads what earlier runs left, and a fresh
  deployment starts with none of it.
- The nightly sweep keeps a workflow's newest deployment through quiet days and takes it only once
  the workflow has not deployed for 7 days (rules 1 and 4 in `preview-sweep.ts`).

## Interactive trace reports

The Preview OS and Main OS e2e workflows end in a CI trace job that posts two commit statuses, **CI
trace** (time to green or red) and **Playwright report**, whose **Details** open the report in the
browser: on a PR's head commit, or main's pushed commit. Re-running a failed suite
(`depot ci retry <run-id> --failed --workflow <workflow-id>`) re-runs the trace job with it; Depot
refuses `--job` for a job whose trace job
has started. A dispatch of `test`, `e2e` or `specs` runs its own trace job. See
[CI traces](./ci-traces.md) for the timing model, the viewer, replay commands
and OTLP JSON export.

## Slack channels

#error-pulse is for what someone must act on, and every message there mentions Jonas and Misha
(`onCallMention` in `scripts/ci/slack.ts`), thread replies included: the [health](#health) pages,
the prd fault alarm, the prd post-deploy check (`scripts/ci/prd-post-deploy-check.ts`), the preview
sweep's pages (`scripts/os/preview.ts sweep`), a failed context sweep
(`scripts/ci/context-sweep.ts post`), a failed prd deploy and any other failed scheduled workflow
(`scripts/ci/notify.ts`). Routine posts go to #ci and mention nobody: each pull request event as one
top-level line (its title cut to 80 characters, its base named only when it is not `main`), each
app's prd deploy as `🚀 <App> live · run` in the thread of its merge's line (`(re-run)` for a second
run of the same commit; top-level with its sha when the deploy was dispatched or no merge's line
appears within 3 minutes), the PR dashboard, the Durable Object cost alarm's daily thread, each
context sweep's result, the orphans it destroyed included (the crash hunt leaves some every night),
and the 🧪 test pages.

Every page keeps one message per incident (`scripts/ci/slack.ts`): `🚨 <what> <mentions>`, then
`Impact:`, `Do:`, the ids to act on and one link. A later run that finds the incident still there
edits the page, which notifies nobody; the first run that finds it gone edits its first line to
start `✅ resolved:` and replies once in its thread, mentioning both. Older open pages of the same
incident are marked resolved naming no one. A page Slack can no longer edit is posted again by its
next edit. One still in the channel (past the workspace's edit window) is closed by a reply in its
thread sent to the channel too, starting `✅ resolved:`, which later runs read as closed: the
resolution itself when the incident ended, else a line naming no one. A deleted page's resolution
goes top-level. The page's first line, or that reply, is its state, so the channel's history is the
only state a poster keeps; a run that sees only part of an incident (the preview
sweep's stuck namespaces, the apps that failed on a commit) carries forward what the open page names.
Only a run on main pages; a 🧪 test run (each workflow's `test-run` input, each `notify.ts` command's
`--test-run`) posts to #ci, mentions nobody and never reads #error-pulse. `notify.ts deploy-success
--test-run` with a merged commit's `GITHUB_SHA` replies in that merge's thread, as its deploy did.

| Poster                                                  | One page per   | Resolved by                                                  |
| ------------------------------------------------------- | -------------- | ------------------------------------------------------------ |
| `notify.ts deploy-failure`                              | failing commit | every app on it live again at a commit that descends from it |
| `prd-post-deploy-check.ts`                              | os-prd         | the next passing check                                       |
| `notify.ts workflow-failure` (Kit firmware, crash hunt) | workflow       | its next green run (`workflow-resolved`)                     |

Another app failing on the same commit, an app live again, or another deploy failing the host check
is an edit of the page, not a reply; a red workflow whose failed jobs change also replies in its
thread. Kit firmware's green run is one that built and published: a run that plans no release
skips both and resolves nothing. A deploy step posts to #ci only when its whole job succeeded,
and a failed post never turns the deploy red. Each PR event's line posts from `pr-dashboard.yml`'s
`notify` job, which has no concurrency group: a group cancels the pending run a newer one replaces,
and that event would get no line.

## Health

Two jobs keep one page in #error-pulse per red signal, with `scripts/monitors/health.ts`:

- **main e2e** and **slow e2e rows**: Main OS e2e's own `alert` job, as soon as
  the run's deploy and both suites have ended, from their results and the suite
  summaries E2E tests and the specs shards upload with their flake records. A push
  run only.
- `health.yml`, every hour, judges what the measuring workflows left:
  - **real-model e2e**: the `REAL:` rows of each scheduled or push run of OS
    real model, from its telemetry.
  - **latency**: each new scheduled OS latency report, against the budgets and a
    rolling baseline; a metric turns red once two runs in a row cross a line.
  - **PR time to green** ([below](#pr-time-to-green)).
  - **DO cost**: the Durable Object cost alarm (`scripts/monitors/do-cost.ts`). Its daily
    thread in #ci is a headline, the $/day at the latest hour's rate and today so far, and one
    reply with a line per account, both edited every hour; an account with a complete hour over
    its ceiling today is a 🔴 line. An account at its page tier is one page in #error-pulse,
    edited every hour while it lasts. The first hour at 2× and at 5× the page tier is a broadcast
    reply in its thread, and two complete hours under the ceiling resolve it. A page is open for
    48 hours: an incident that lasts longer is paged again, and the new page resolves the older
    one naming no one.

What each verdict owes its signal's page (`scripts/monitors/page.ts`):

| Verdict                                                                     | What the channel gets                                                                                   |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Red or unjudged after green                                                 | A page: what broke at which commit with both mentions, its impact, what to do, the run                  |
| Still red                                                                   | An edit of the page: the newest commit, the failing jobs and rows, "red since `<sha>`, N runs"          |
| Still red, failing a job or row the page has not named                      | The edit, and a thread reply naming the new failures                                                    |
| PR time to green more than 20 s worse again                                 | The edit, and a thread reply broadcast to the channel                                                   |
| Green again                                                                 | A `✅ resolved: …` thread reply, and the page's first line edited to start `✅ resolved:`               |
| Unjudged after red, or red after unjudged                                   | The open page resolved and a new one opened: an unjudged page never hides a red one                     |
| Any, when Slack can no longer edit the page (deleted, past its edit window) | The update goes top-level: a new page, with any escalation reply in its thread, or the resolution reply |

A check that could not read Depot, or found its probe broken (a report with no rows, a suite that
did not run), fails the job once the others have paged. Main OS e2e's page job reports on the
commit its run tested, where red reads as "main e2e broke": a broken probe of its slow rows (a
slow row not run, an incomplete or missing suite summary) is an "unjudged" page instead, and the
job fails only when it cannot judge its run or post. Each run since the last judged is judged,
oldest first, so a page names the run where its suite changed state: Main OS e2e's page job judges
its own run after any settled one whose page was lost. Runs of Main OS e2e overlap, so its page jobs
take turns, oldest run first: each waits until no push run created before its own is queued or
running (`health.ts await-older-runs`), then reads the state the one before it kept. One that has
waited 30 minutes fails, and the next run's page job judges its run after the older ones. A settled
run that Depot ended before its jobs started has no verdict. A re-run keeps its creation time and is
not judged again, so the next push's run pages it.

Each job's memory is its own artifact, `health-state` and `main-e2e-state`: its checks' memory
and each open page's Slack ts and text, written only after every post succeeded. A state of another
`schemaVersion` is not read, and the job starts over. Dispatch `health.yml` with
`--input test-page=true` to post every one of its checks' verdicts to #ci as a 🧪 test page, which
mentions nobody, keeps no state and sends PostHog nothing; a run off main without it posts
nothing. A dispatch of Main OS e2e pages nothing; `health.ts main-e2e --workflow-id <id>
--test-page` posts a past run's verdicts to #ci the same way.

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

It opens a page when the pushes that skipped the slow rows took a p50 over 165 s or a p90 over
200 s across the last 24 hours, judged from 20 such pushes up; edits it hourly while they stay
over; escalates whenever that p50 is more than 20 s over the lowest it judged since the page or its
last escalation; and resolves it once both are back under. The lines hold the owner's rule that a
push is green within 3 minutes (`LINES` in the script). The page names the job that finished last
on most of those pushes (`preview-os.yml:specs`, say).

## Browser reports from artifacts

A report link means the report is available, not that the suite passed: the reports upload even
after test failures. Links use Depot artifact UUIDs and expire
with them. The workflows ask for 30 days, but Depot keeps artifacts about a
week ([test evidence](test-evidence.md) keeps them in R2). Anyone can open an artifact whose name
starts with `public-` at `https://ci-reports.iterate-dev-preview.workers.dev/<artifact-id>/`
([CI traces](./ci-traces.md#the-viewer)), so upload only files intended to be public.

Each Browser specs shard prints Playwright's report of its share into its job log, and uploads its
artifacts even when the suite fails:

- `public-playwright-report`, from Browser specs: the HTML report of every shard
  (`test-results/playwright-html`), which the **Playwright report** status opens; a failed spec's
  trace opens in its trace viewer.
- `preview-os-test-artifacts-attempt-<id>` (main: `main-os-test-artifacts-attempt-<id>`): all of
  `test-results/`, one per job attempt ([above](#artifacts-per-job-attempt)). Each failed spec's
  `trace.zip`, screenshot and `error-context.md` are under `playwright-output/<test>/`, and the
  shard's blob report under `playwright-blob/`.

Fetch either with `depot ci artifacts`, unzip, and open it with
`pnpm exec playwright show-report <dir>` or `pnpm exec playwright show-trace <trace.zip>`.
