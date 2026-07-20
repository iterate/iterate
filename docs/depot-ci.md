# Depot CI

CI workflows live in `.depot/workflows/*.yml` and run on
[Depot CI](https://depot.dev/docs/ci/overview). The files use GitHub Actions
YAML syntax, but Depot owns the run lifecycle, check reporting, logs, metrics,
secrets, and local dispatch.

The old TypeScript workflow generator is gone. Edit the YAML directly, and put
runtime logic in normal scripts under `scripts/ci` instead of embedding large
`actions/github-script` blocks.

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
- Secrets and variables are managed with `depot ci secrets` and `depot ci vars`,
  not GitHub Actions secrets.

The only GitHub Actions workflow left is `.github/workflows/claude-assistant.yml`.
It is not CI; it exists because Depot CI does not support issue/comment events
such as `issues`, `issue_comment`, or PR review comment triggers.

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

Control runs:

```bash
depot ci rerun <run-id> --org 0p91s0lz49
depot ci retry <run-id> --org 0p91s0lz49
depot ci cancel <run-id> --org 0p91s0lz49
```

Manage secrets:

```bash
depot ci secrets list --org 0p91s0lz49
printf '%s' "$VALUE" | depot ci secrets add NAME --org 0p91s0lz49
depot ci secrets remove NAME --org 0p91s0lz49
```

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
answers `BLOCKED` (required things missing — including unresolved review
threads), `UNSTABLE` (something failing that is NOT required — preview e2e is
in this category), or `CLEAN`. A wait-for-green loop that treats `UNSTABLE`
as fatal waits forever on a red non-required check.

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
  --workflow cloudflare-previews.yml \
  --ref <branch> \
  --input pull-request-number=<pr-number>
```

Deploy a branch manually:

```bash
depot ci dispatch --org 0p91s0lz49 --repo iterate/iterate \
  --workflow deploy-os.yml \
  --ref <branch> \
  --input ref=<branch>
```

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
  destination, such as `deploy-auth-os-production`. It always sets
  `cancel-in-progress: false`. The checked-out branch is not the destination,
  so it must not appear in that group name. An active rollout finishes; if
  several newer commits queue behind it, Depot keeps the newest pending run.
- Tests, lint/typecheck, and autofix use the source branch (falling back to
  `ref_name`) and `cancel-in-progress: true`. A newer commit makes an older
  validation result obsolete, including on `main`.
- Every mainline job has `timeout-minutes`. This is a watchdog, not a retry:
  jobs fail at the outer edge and an operator decides whether a rerun is safe.
  Auth + OS gets 45 minutes because its bounded worst case includes both
  deployments, JWKS propagation, and four sequential smoke probes.
- Runner size follows observed peak CPU and memory, with headroom. Lint stays
  on `8x32` (parallel oxlint/typecheck/knip). Unit tests use `4x16` — measured
  peaks on `8x32` were ~3 cores / ~2.5GB, and a second large sandbox next to
  lint is the common trigger for no-log `Sandbox terminated before worker
reported completion` on main. Auth + OS deploy uses `4x16`; short deploy,
  notification, and autofix jobs use `2x8`. Re-check with
  `depot ci metrics --run <run-id>` before increasing a size.

These defaults keep a normal all-app main push to 28 requested vCPUs before
notification jobs, down from 72, without reducing the parallel lint lane that
uses the larger machine.

If an attempt receives a sandbox but produces no logs or metrics before
failing, inspect `depot ci status`, `logs`, `metrics`, and `diagnose`. When the
same commit and image pass on rerun, treat that as runner provisioning evidence,
not an application failure. Do not add automatic workflow retries: deployment
reruns can repeat external side effects and need an operator decision.

## Custom Image

The baked image is built by `.depot/workflows/build-preview-ci-image.yml` using
`scripts/depot-ci/bake-preview-ci-image.sh`.

It contains Node, pnpm, workspace dependencies, Doppler CLI, and the preview
browser. A snapshot is independent of sandbox size: choose `2x8`, `4x16`, or
`8x32` from measured workload demand. Jobs that consume it must keep the image
and checkout behavior:

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

## Trigger Gotchas

Depot registers automatic triggers from the default branch. If you change an
`on:` block on a feature branch, automatic `push` or `pull_request` behavior may
not be visible until the workflow file lands on `main`. Use `depot ci run` for
local workflow validation and `depot ci dispatch` for `workflow_dispatch`
coverage.

`workflow_dispatch` and automatic PR runs can share concurrency groups. For the
preview workflow, a manual dispatch and an automatic PR run for the same PR can
cancel each other. When validating previews, use one path at a time.

`depot ci logs` accepts a run id, job id, or attempt id. When a run has multiple
jobs, pass `--job <job-key>` or use `depot ci status <run-id> --output json` to
find the exact job/attempt id.

When the autofix job fails with `pull request parse error: cannot find workflow
run named "autofix.ci"`, the real signal is that autofix found a diff to apply
(the apply step only contacts GitHub when there is one) and could not correlate
the Depot run with a GitHub Actions run. Look at the `git diff` output in the
job logs, apply the same fix locally (usually `pnpm format`), and push.
