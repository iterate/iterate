# Depot CI

We run CI on [Depot CI](https://depot.dev/docs/ci) — Depot's own CI control
plane — not just GitHub Actions. Depot CI assigns a runner in ~7s where GitHub
Actions runner assignment measured 20s–3m39s (and once ~40min during a webhook
incident), so the latency-sensitive checks live there.

This doc is the practical guide: how it works, how to interact with it, and the
commands you'll actually use. For the preview pipeline specifically, see
[Preview CI performance](ci-preview-performance.md); for the GitHub-Actions side
and the workflow generator, see [CI workflows](ci-workflows.md).

## How it works

- **Workflows live in `.depot/workflows/*.yml`** and use GitHub Actions YAML
  syntax (Depot runs it largely unmodified). Depot's GitHub App reports each
  job back to the PR as a normal check (the "Cloudflare Previews (Depot CI) /
  …" checks you see on a PR come from Depot).
- **Triggers register on the default branch.** When a workflow file lands on
  `main`, Depot registers its `on:` triggers. Branch-only changes to the `on:`
  block don't take effect until merged — test a branch with `depot ci dispatch`
  (below).
- **Supported triggers:** `push`, `pull_request`, `pull_request_target`,
  `pull_request_review`, `schedule`, `workflow_call`, `workflow_dispatch`,
  `workflow_run`, `merge_group`. **Not supported:** `issue_comment`, `issues`,
  `pull_request_review_comment` (this is why `claude-assistant` stays on GitHub
  Actions).
- **Secrets** come from `depot ci secrets` (org-scoped), not GitHub secrets.
- **Org / dashboard:** org id `0p91s0lz49`,
  [dashboard](https://depot.dev/orgs/0p91s0lz49/workflows).

## Commands you'll use

```bash
# --- watch runs ---
depot ci run list      --org 0p91s0lz49 --repo iterate/iterate          # queued/active runs
depot ci workflow list --org 0p91s0lz49 --repo iterate/iterate          # per-workflow rows incl. sha + run id
depot ci status <run-id>     --org 0p91s0lz49 [--output json]           # run/job/attempt tree
depot ci logs   <attempt-id> --org 0p91s0lz49 [--timestamps] [--output-file f.log]

# --- run something ---
# Trigger a workflow on a branch WITHOUT merging (uses the branch's version of the file):
depot ci dispatch --org 0p91s0lz49 --repo iterate/iterate \
  --workflow cloudflare-previews.yml --ref <branch> --input pull-request-number=<pr>

# Run a workflow from your local checkout (uploads uncommitted changes as a patch):
depot ci run --workflow .depot/workflows/<file>.yml --org 0p91s0lz49 --job <job>

# --- diagnostics ---
depot ci metrics --run <run-id> --org 0p91s0lz49 --output json          # CPU/mem utilization (runner sizing)
depot ci diagnose <run-id> --org 0p91s0lz49                             # failure triage
depot ci rerun    <run-id> --org 0p91s0lz49                             # re-run a workflow
depot ci cancel   <run-id> --org 0p91s0lz49

# --- secrets ---
depot ci secrets list --org 0p91s0lz49
printf '%s' "$VALUE" | depot ci secrets add NAME --org 0p91s0lz49
depot ci secrets remove NAME --org 0p91s0lz49
```

## Gotchas

- **`workflow_dispatch` and `pull_request` runs share a concurrency group** (the
  preview workflow's `cloudflare-previews-<pr>` with `cancel-in-progress: true`),
  so a manual `dispatch` and the automatic PR run **cancel each other**. When
  validating, either rely on the PR run or the dispatch — not both at once.
- **`depot ci logs --output-file` lags a live run** — the export can trail the
  actual progress by a chunk; re-fetch until the line you expect appears.
- **Run id vs workflow id vs attempt id** — `depot ci run list` shows _run_
  ids; `depot ci workflow list` shows _workflow_ ids (with the run id in the
  last column); `logs` wants the _attempt_ id (from `status … --output json`).
- **The preview e2e check is not a required check** — a red preview
  (e.g. a cold-slot signup flake) does not block merge if the required checks
  (lint-typecheck, test, generate) are green.

## Migrating a workflow to Depot CI

Generated workflows live in `.github/ts-workflows/workflows/*.ts` and emit to
`.github/workflows/` (GitHub Actions) or `.depot/workflows/` (Depot CI). The
generator (`.github/ts-workflows/cli.ts`) routes a workflow to Depot when its
name is in `DEPOT_WORKFLOW_NAMES`; it writes the yaml to `.depot/workflows/` and
deletes the stale `.github/workflows/` copy on `pnpm workflows`.

To move a workflow:

1. Add its name to `DEPOT_WORKFLOW_NAMES` in `.github/ts-workflows/cli.ts`.
2. Point the job at the **baked image** and drop the per-run installs — replace
   `...utils.runsOnDepotUbuntu` + the checkout/pnpm/node/install steps with
   `...utils.runsOnDepotImage` + `...utils.setupFromImage()`. The image
   (`build-preview-ci-image.yml`) has node/pnpm/`node_modules`/Doppler/chromium
   baked, so the job skips `pnpm install` and the Doppler install — that's the
   speed — and `DOPPLER_TOKEN` becomes the only secret it needs — that's the
   one-secret model (source Slack/bot tokens from Doppler, see `utils/slack.ts`).
3. `pnpm workflows && pnpm --dir .github/ts-workflows build`.

### The validation constraint (read before merging)

**Depot registers a workflow's triggers only from the default branch.** A moved
workflow therefore cannot be run on Depot from a branch — not via `pull_request`
(unregistered), not via `depot ci dispatch` ("does not have workflow_dispatch
trigger" until it's on `main`), and `depot ci run` can't apply the
`.github`→`.depot` rename patch. So a migrated workflow is **only observable
after it merges to `main`** and the next push/PR runs it.

That makes this a **staged, watched rollout**, not a blind bulk move:

1. Merge one workflow at a time (start with a non-required, low-risk one).
2. Watch the first `main` push / PR run it on Depot; fix forward if the baked
   image or `setupFromImage` reconcile misbehaves.
3. Only then add the next workflow to `DEPOT_WORKFLOW_NAMES`.
4. **Prod deploys (`deploy-*`, `release`) go last** and each gets validated in
   isolation — a broken deploy on Depot has real blast radius.

What _is_ verifiable up front: the image is consumable (`node`, `pnpm`,
`doppler`, and a 2.6G `node_modules` are all present in a
`runs-on: { image }` job — probed 2026-07-03), and the generated yaml + routing
are correct.

## Docs

- [Depot CI overview](https://depot.dev/docs/ci) ·
  [quickstart](https://depot.dev/docs/ci/quickstart) ·
  [GitHub Actions compatibility](https://depot.dev/docs/ci/compatibility) ·
  [CLI reference](https://depot.dev/docs/cli/reference/depot-ci)
