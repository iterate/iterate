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

## Docs

- [Depot CI overview](https://depot.dev/docs/ci) ·
  [quickstart](https://depot.dev/docs/ci/quickstart) ·
  [GitHub Actions compatibility](https://depot.dev/docs/ci/compatibility) ·
  [CLI reference](https://depot.dev/docs/cli/reference/depot-ci)
