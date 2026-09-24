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
- A throwaway preview plus e2e (Main OS e2e) may run in parallel, but nothing waits on it; so
  does the latency guard (`os-latency.yml`), on a throwaway preview of its own.
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
  `0p91s0lz49.registry.depot.dev/iterate-preview-ci:node24-pnpm10-worktree`
- `DOPPLER_TOKEN` is the only Depot CI secret. Application and service
  credentials live in Doppler; GitHub supplies a short-lived job token.
- Non-secret variables are managed with `depot ci vars`.

Two GitHub Actions workflows are left, both for what Depot cannot do:

- `.github/workflows/pkg-pr-new.yml` is not CI; it publishes the `iterate` SDK and the
  `@iterate-com/cli` packages to [pkg.pr.new](https://pkg.pr.new) for every `main` push, and for
  a PR that changes their inputs (`packages/iterate`, `packages/cli`, the root manifests and
  lockfile, or the workflow itself): the **publish** and **Continuous Releases** checks.
- `.github/workflows/merges-with-main.yml` is the **Merges with main** check, on
  `pull_request_target`: a PR that conflicts with main gets a red check instead of none
  ([Pull requests that conflict with main](#pull-requests-that-conflict-with-main)).

Anything else that needs GitHub-only triggers, such as `pull_request_target`, `issues`,
`issue_comment`, or PR review comment events, which Depot CI does not support, belongs there too.

## Workflows

| File                         | Runs on                                                  | What it does                                                                                            |
| ---------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `lint-typecheck.yml`         | PR, main push, dispatch                                  | **Lint and Typecheck** (required): lint, typecheck, format check, knip                                  |
| `test.yml`                   | PR, main push                                            | **Test** (required): `pnpm test`, then the Kit firmware host tests                                      |
| `loc-report.yml`             | PR, dispatch                                             | The LOC table in the PR body                                                                            |
| `pr-dashboard.yml`           | PR opened, reopened, ready, drafted or closed            | The Slack PR update and the daily PR dashboard                                                          |
| `preview-os.yml`             | PR touching the preview paths, dispatch                  | **Preview OS**: the PR's preview, its e2e job, the CI trace and report statuses                         |
| `preview-delete.yml`         | Such a PR closing, dispatch                              | Deletes the PR's preview                                                                                |
| `preview-sweep.yml`          | Nightly, dispatch                                        | Deletes stale previews and orphaned preview resources                                                   |
| `main-os-e2e.yml`            | Main push touching the preview paths, dispatch           | **Main OS e2e**: a throwaway preview of main, e2e and specs, trace, delete, alert                       |
| `deploy-os.yml`              | Main push touching what OS ships, dispatch               | **Deploy OS**: production, then the project-host check                                                  |
| `deploy-<app>.yml`           | Main push touching what the app ships, dispatch          | Deploy of Dash, Agents, Notes, Voice, Kit, SPA, dummy-petshop or ci-reports                             |
| `kit-firmware.yml`           | Firmware PR and main push, daily, dispatch               | Builds the changed boards; main publishes their releases                                                |
| `build-preview-ci-image.yml` | Main push touching install inputs, weekly, dispatch      | Bakes the CI image ([Custom Image](#custom-image))                                                      |
| `do-duration-probe.yml`      | Hourly, dispatch                                         | Durable Object cost alarm for both Cloudflare accounts                                                  |
| `prd-fault-alarm.yml`        | Every 15 minutes, dispatch                               | Reads production's Workers Logs and pages #error-pulse on faults                                        |
| `os-crash-hunt.yml`          | Nightly, dispatch                                        | The opt-in isolate-ceiling rows against production                                                      |
| `os-e2e-soak.yml`            | Dispatch                                                 | The e2e suite N times against one deployed worker, each run then the perf budgets                       |
| `os-latency.yml`             | Every 3 hours, main push to the Worker's paths, dispatch | **OS latency**: the perf suite against a throwaway preview of main; PostHog; pages on a change of state |
| `os-real-model.yml`          | Daily, main push to the agents runtime, dispatch         | **OS real model**: the `REAL:` rows on a throwaway preview of main; pages on a change of state          |
| `flake-dashboard.yml`        | Hourly, dispatch                                         | Folds the flake records into [#2580](https://github.com/iterate/iterate/issues/2580)                    |
| `ci-telemetry.yml`           | Hourly, dispatch                                         | One PostHog event per Depot workflow run and job attempt                                                |
| `release.yml`                | Daily, dispatch                                          | A dated `v…` release with a changelog when main moved                                                   |

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

### Artifacts per job attempt

The Test job and the preview and main e2e jobs name every evidence artifact
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
  --workflow preview-os.yml \
  --ref <branch> \
  --input pull-request-number=<pr-number> \
  --input action=deploy
```

`action` is `deploy | reset | e2e` and `apps` is
`all | auto | none` (the clients on top of the platform preview); the header of
`.depot/workflows/preview-os.yml` documents each. Deleting a PR's preview
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
  destination, such as `deploy-os-production`. It always sets
  `cancel-in-progress: false`. The checked-out branch is not the destination,
  so it must not appear in that group name. An active rollout finishes; if
  several newer commits queue behind it, Depot keeps the newest pending run.
- Tests and lint/typecheck use the source branch (falling back to
  `ref_name`) and `cancel-in-progress: true`. A newer commit makes an older
  validation result obsolete, including on `main`.
- Main OS e2e is the exception: one fixed group, `main-os-e2e`, with
  `cancel-in-progress: false`. A run creates a throwaway preview and deletes it
  in a later job, and cancelling a run cancels that `always()` delete too, so
  every started run finishes, delete and alert included. Pushes that land
  meanwhile collapse to the newest pending run. The latency guard
  (`os-latency.yml`, group `os-latency`) is built the same way for the same
  reason, and cutting a measurement short at every merge would starve it. So is
  the real-model suite (`os-real-model.yml`, group `os-real-model`).
- Every mainline job has `timeout-minutes`. This is a watchdog, not a retry:
  jobs fail at the outer edge and an operator decides whether a rerun is safe.
  Deploy OS gets 30 minutes: its bounded worst case is the build, the rollout,
  the deploy script's readiness probes, the host check (≤ 60 s for `/version`
  to name the new version, then four tries of each production project host)
  and its Slack notice, all in the one job. The client deploys get 15–20.
- Runner size follows observed peak CPU and memory, with headroom. Lint stays
  on `8x32` (parallel oxlint/typecheck/format check/knip). Unit tests use `4x16` — measured
  peaks on `8x32` were ~3 cores / ~2.5GB, and a second large sandbox next to
  lint is the common trigger for no-log `Sandbox terminated before worker
reported completion` on main. Deploy OS uses `4x16`; the client
  deploys (Dash, Agents, Notes, Voice, Kit, SPA, dummy-petshop, ci-reports),
  the trace jobs, Main OS e2e's delete and alert jobs, and the jobs that only call APIs (LOC report, PR
  dashboard, Release) use `2x8`. Re-check with `depot ci metrics --run <run-id>`
  before increasing a size.

These defaults keep a normal all-app main push to 34 requested vCPUs (lint 8,
test 4, Deploy OS 4, 2 for each of the seven client deploys, and 4
for Main OS e2e, whose parent, deploy and e2e jobs run one after another; its
trace, delete and alert jobs follow them), without reducing the parallel lint job that
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
`scripts/depot-ci/esp-idf.sh` and in each target's `dependencies.lock`. The CI
image carries that ESP-IDF, so a leg downloads none of it: `esp-idf.sh ensure`
checks the image's receipt against the script and installs from the network,
with a warning, only while they differ (a pull request that changes the script,
or main until the image bake that change triggers finishes). The legs still
fetch each target's managed components. Details: [Kit firmware releases](../apps/kit/README.md#firmware-releases).

## Custom Image

The baked image is built by `.depot/workflows/build-preview-ci-image.yml` using
`scripts/depot-ci/bake-preview-ci-image.sh`.

It contains Node, pnpm, workspace dependencies, Doppler CLI, the preview
browser, and Kit Firmware's ESP-IDF ([Kit firmware releases](#kit-firmware-releases)). A snapshot is independent of sandbox size: choose `2x8`, `4x16`,
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
run and the Preview delete run for the same PR share `preview-os-<pr>` with
`cancel-in-progress: false`: neither cancels the running one, but a newer
pending run replaces an older pending one, so a dispatch queued behind a push
can silently disappear. When validating previews, use one path at a time.

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
workflow without one. It records a run with no commit and no workflows (`depot ci run list
--output json` shows it with no `sha`), and the PR shows no Lint and Typecheck, Test or Preview OS
checks: not red, not pending, absent. On 2026-09-24 between 09:23 and 09:59 UTC there were six
such runs, for heads of #3004, #3006 and #3007, and each head conflicted with main at that moment
(`git merge-tree`). #3007 sat with only Bugbot's check until it was rebased.

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

## Which PRs get a preview

The Preview OS workflow (`.depot/workflows/preview-os.yml`, cribbed from
cloudflare-os) selects PRs by its `pull_request.paths` list: `apps/os`,
`configs`, the five hosted clients (`apps/dash`, `apps/agents`,
`apps/notes`, `apps/voice`, `apps/kit` but not its firmware), `specs` and
`playwright.config.ts`, `packages/cli` (the e2e drives the built CLI),
`packages/iterate`, `packages/shared`, `packages/ui`, the root manifests and lockfile,
`envs.ts`, `scripts/lib`, `scripts/depot-ci`,
and its own and the six production deploy workflows (OS, Dash, Agents, Notes,
Voice, Kit: a production-workflow change must exercise the isolated
deployment). A PR that
touches none of them, such as docs, lint rules or Kit firmware, gets no preview
checks at all: they never appear, rather than reporting a skip. The Preview
delete workflow (`.depot/workflows/preview-delete.yml`) runs on the same list
when such a PR closes; `scripts/ci/depot-workflows.test.ts` keeps the two lists
equal.

## Which main pushes deploy

Each `deploy-<app>.yml` runs on a push to `main` that touches what its app
ships: the app, the workspace packages it depends on, `envs.ts`, `scripts/lib`
and `pnpm-lock.yaml`, and for OS and the five hosted clients the root
`package.json` and `pnpm-workspace.yaml` too. `scripts/ci/depot-workflows.test.ts`
pins the exceptions:

- No client deploy runs for `apps/os`: no client imports it.
- Deploy Kit and Deploy Voice also run for `apps/agents`: their
  `vite.config.ts` builds `voice-install.json` from it.
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

The Preview OS workflow runs **deploy**, then **e2e** as a separate job with
`needs: deploy` (#2861). The e2e job starts only behind a deploy that succeeded,
or alone on an `action=e2e` dispatch, then runs the Vitest e2e suite and the
Playwright specs concurrently against the live preview (`runE2e` in
`apps/os/scripts/preview.ts`). Job dependencies replace milestone signalling:
there is no commit status to wait for, and a red e2e can run again without a
redeploy (dispatch `action=e2e`, or retry the e2e job and then the trace job), because the preview persists
until the PR closes.

## Interactive trace reports

The Preview OS and Main OS e2e workflows' `trace` job runs after the jobs it
needs, whatever their outcome, and posts two commit statuses whose **Details**
open the report in the browser:

- **CI trace**: the time to green or red. The report shows workflow → jobs →
  setup/test phases → shell steps → Playwright attempts and Vitest tests.
- **Playwright report**: the e2e job's Playwright HTML report, when the suite
  ran.

A PR's statuses are on its head commit, main's on the pushed commit. Retrying
one job (`depot ci retry <run-id> --job <job-id>`) re-runs that job alone, so
after retrying e2e, retry the run's trace job too: it re-collects the trace and
re-posts both statuses at the new uploads. A dispatch with `action=e2e` runs
its own trace job. See
[CI traces](./ci-traces.md) for the timing model, the viewer, replay commands
and OTLP JSON export.

## Browser reports from artifacts

A browser-readable report is uploaded as a Depot artifact even after test
failures, and the check keeps the actual test outcome: a report link means the
report is available, nothing more. Links use Depot artifact UUIDs and expire
with their 30-day retention. An artifact whose name starts with `public-` can
be opened by anyone at `https://ci-reports.iterate-dev-preview.workers.dev/<artifact-id>/`
([CI traces](./ci-traces.md#the-viewer)), so upload only files intended to be public.

The Preview OS and Main OS e2e jobs print Playwright's report into the job log
after Vitest's, and upload two artifacts even when the suite fails:

- `public-playwright-report`: Playwright's HTML report
  (`test-results/playwright-html`), kept 30 days. The **Playwright report**
  status opens it; a failed spec's trace opens in the report's trace viewer.
- `preview-os-test-artifacts-attempt-<id>` (main:
  `main-os-test-artifacts-attempt-<id>`): all of `test-results/`, one per job
  attempt ([above](#artifacts-per-job-attempt)). Each failed spec's
  `trace.zip`, screenshot and `error-context.md` are under
  `playwright-output/<test>/`, next to `playwright-results.json` and the
  telemetry.

Fetch either with `depot ci artifacts` as shown above, unzip, and open it with
`pnpm exec playwright show-report <dir>` or
`pnpm exec playwright show-trace <trace.zip>`. The Test workflow uploads
`unit-test-telemetry-attempt-<id>` and `flake-records-unit-attempt-<id>`.
