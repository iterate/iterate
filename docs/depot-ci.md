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

### What has moved, and what can't (yet)

**On Depot** (`DEPOT_WORKFLOW_NAMES`): `lint-typecheck`, `test`, `deploy-auth`,
`deploy-tunnels`, `release`, `autofix`, `pullfrog`. Each needs only the secrets
Depot already has — `DOPPLER_TOKEN` (+ `ITERATE_BOT_GITHUB_TOKEN` for the
github-script jobs).

**Still on GitHub Actions, and why** — two blockers:

1. **Slack.** `ci`, `nag`, `pr-dashboard`, and the cloudflare-app deploys
   (`deploy-os`, `deploy-semaphore`, `deploy-streams-example-app`, via their
   `slack-success` / `slack-failure` jobs) post to Slack with
   `SLACK_CI_BOT_TOKEN`. That token is a **GitHub repo secret** — it is _not_ in
   Depot's secrets and _not_ in Doppler `_shared/prd` (verified 2026-07-03).
   Until it's reachable from Depot, these can't move.
2. **Reusable-workflow coupling.** `deploy` is `workflow_call`-only, invoked by
   `ci.yml` via `./.github/workflows/deploy.yml`. A GitHub Actions workflow can
   only call a reusable workflow under `.github/workflows/` — never `.depot/` —
   so `deploy` stays wherever `ci` is. `ci` is slack-blocked, so `deploy` is too.

`claude-assistant` (issue_comment/issues triggers Depot doesn't support) and
`generate-workflows` (the self-referential guardian) stay on GitHub permanently.

### Finishing the migration (one secret, then flip)

To move the remaining six, make `SLACK_CI_BOT_TOKEN` reachable from Doppler so
the "one secret" model holds (Depot needs only `DOPPLER_TOKEN`):

1. Add `SLACK_CI_BOT_TOKEN` to Doppler `_shared/prd` (the config Depot's
   `DOPPLER_TOKEN` resolves).
2. Rewire the `getSlackClient("${{ secrets.SLACK_CI_BOT_TOKEN }}")` call sites
   (in `ci.ts`, `nag.ts`, `pr-dashboard.ts`, `cloudflare-app-workflow.ts`) to
   `getSlackClient()` — the no-arg form falls back to
   `getSlackBotToken()`, which reads it from Doppler (see `utils/slack.ts`).
   Ensure those jobs run under a Doppler context (`setupDopplerBaked` +
   `DOPPLER_TOKEN` env).
3. Add `ci`, `nag`, `pr-dashboard`, `deploy-os`, `deploy-semaphore`,
   `deploy-streams-example-app` to `DEPOT_WORKFLOW_NAMES`. `ci` calls `deploy`
   as a reusable workflow, so move `deploy` in the same step and update the
   `uses:` path from `./.github/workflows/deploy.yml` to
   `./.depot/workflows/deploy.yml` (Depot resolves local `.depot` reusable
   workflows).

### The validation constraint (read before merging)

**Depot registers a workflow's triggers only from the default branch.** A moved
workflow therefore cannot be run on Depot from a branch — not via `pull_request`
(unregistered), not via `depot ci dispatch` ("does not have workflow_dispatch
trigger" until it's on `main`), and `depot ci run` can't apply the
`.github`→`.depot` rename patch. So a migrated workflow is **only observable
after it merges to `main`** and the next push/PR runs it. There are no required
status checks on `main` (verified via the "Protect Main" ruleset 2026-07-03), so
a moved check can't block merges — but it also means **babysit `main` after
merge**: watch the next push/PR exercise each moved workflow on Depot and fix
forward if the baked image or `setupFromImage` reconcile misbehaves.

What _is_ verifiable up front: the image is consumable (`node`, `pnpm`,
`doppler`, and a 2.6G `node_modules` are all present in a
`runs-on: { image }` job — probed 2026-07-03), the generator is drift-clean, and
the generated yaml + routing are correct.

## Docs

- [Depot CI overview](https://depot.dev/docs/ci) ·
  [quickstart](https://depot.dev/docs/ci/quickstart) ·
  [GitHub Actions compatibility](https://depot.dev/docs/ci/compatibility) ·
  [CLI reference](https://depot.dev/docs/cli/reference/depot-ci)
