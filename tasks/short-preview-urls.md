---
status: in-progress
size: medium
---

# Short preview URLs, preview parents deployed from main

**Status:** implemented, waiting on CI. Done: `pr<n>` names, parents renamed and deployed from this
branch, Preview parents workflow, nightly reset of the `os` parent (run once for real), sweep guard,
docs. Left: CI green, review, then the post-merge migration (steps 2–4 below).

## Why

PR previews are hard to tell apart:

```
https://pr3065-kit-feedback-todo-os-preview.iterate-dev-preview.workers.dev
https://pr3065-kit-feedback-todo-dash-preview.iterate-dev-preview.workers.dev
https://pr3065-kit-feedback-todo-kit-preview.iterate-dev-preview.workers.dev
```

Cloudflare builds a Worker Preview's URL as `<preview name>-<parent worker>.<subdomain>.workers.dev`.
Ours are `pr<n>-<branch slug>` + `-os-preview`. The branch slug is noise (the PR number is already
unique), and `-preview` is a leftover from the numbered preview slots (`os-next-preview-1`, …) that
predate Worker Previews (#2753).

Wanted:

| URL                                           | Equivalent of                |
| --------------------------------------------- | ---------------------------- |
| `pr3065-os.iterate-dev-preview.workers.dev`   | os.iterate.com, at PR 3065   |
| `pr3065-dash.iterate-dev-preview.workers.dev` | dash.iterate.com, at PR 3065 |
| `pr3065-kit.iterate-dev-preview.workers.dev`  | k.iterate.com, at PR 3065    |
| `os.iterate-dev-preview.workers.dev`          | os.iterate.com, at main      |
| `dash.iterate-dev-preview.workers.dev`        | dash.iterate.com, at main    |

Today the app parents (`dash-preview`, …) run whichever PR's config first found them missing,
pointed at that PR's (long deleted) platform preview. Deploying every parent from main makes the
parents a usable main-on-dev environment, and sets up a later change where an app-only PR previews
just the app against the parent platform (not in this task).

## Decisions

- **PR preview name is `pr<n>`.** No branch slug. A run without a PR number (local, CI workflows'
  own `main`/`latency`/`real-model`/`slow-e2e`, experiments, soak) keeps its slugified name.
- **Parent workers are named after the app**: `os`, `dash`, `agents`, `notes`, `voice`, `kit` on the
  dev/preview account (envs.ts `*Envs.preview`). All six names were free on 2026-09-24.
- **The `os` parent gets fresh resources**, `os-parent-oauth`, `os-parent-itx` KV, `os-parent-files`
  R2, `os-parent-repos` Artifacts, via `ensure-resources --env preview`. Not `os-*`: local dev's R2
  bucket is `os-files` (wrangler.base.jsonc), and a preview's resources are `os-<preview>-…` (the CI
  preview `main`'s would be `os-main-…`). Not the `os-preview-*` ones: the old `os-preview` worker
  still binds them, and erase-data refuses a store two Workers bind.
- **An environment's apps point at the same environment's platform.** A `preview` build of an app
  (its parent) signs in against `os.iterate-dev-preview.workers.dev` and links to the other preview
  parents; `prd` keeps prd's. PR previews still override both with the PR's own URLs.
  `osEnvs.preview.dashBaseUrl` names the dash parent.
- **Parents deploy on every push to main**, from a new workflow `preview-parents.yml` (not
  `deploy-*.yml`: the workflow tests read those as prd deploys)
  (`push: main` with the same paths a PR preview runs for, plus `workflow_dispatch` with a `ref`
  input), one job, one concurrency group, never cancelled. It replaces Main OS e2e's `parent` job.
  - Main OS e2e no longer waits for the parent. A preview does not depend on its parent's Durable
    Object classes: #2888's brand-new preview bound `ControlPlaneDurableObject` while the parent
    lacked it, redeploying the parent did not fix the existing previews (#2916), and a throwaway
    worker's new preview bound a class its parent never had (measured, see the log).
  - The app-preview fallback that deployed a PR's preview config as a missing parent goes: a missing
    parent is an error that says to run Deploy preview parents.
- **Every PR with a preview path gets the full set** (platform + every app), as today. No partial
  deploys. PRs that change no preview path still deploy nothing.
- **Nightly cleanup** (preview-sweep.yml, already nightly):
  - the existing sweep of stale PR previews and orphaned per-preview resources, taught the `pr<n>`
    names;
  - a reset of the `os` parent's own data (people will use `dash.iterate-dev-preview.workers.dev`),
    then a redeploy of the parent (`pnpm preview reset-parent`, a second job of preview-sweep.yml
    in the parents' concurrency group). Measured safe: a tombstone on the parent retires only the
    parent's own namespaces, and with `preview_urls: true` on the parked worker every preview keeps
    serving. do-reset.ts skips namespaces the listing marks `preview`.
- **The sweep guards the shorter prefix.** Per-preview resources become `os-<preview>-<suffix>`, and
  `os-` also prefixes resources no preview owns (local dev's `os-dev-repos`, the parent's own). The
  sweep never treats a resource envs.ts or wrangler.base.jsonc names as a preview's.
- **Migration is done after merge, by hand** (not in code):
  1. before merge: `ensure-resources --env preview`, then deploy the parents from this branch, so this
     PR's own preview runs under the new names;
  2. merge, then merge main into every open PR that has a preview; each one's next Preview OS run
     creates `pr<n>` previews under the new parents;
  3. delete every preview (and its per-preview KV/R2/D1/Artifacts) under the old `*-preview`
     parents; the sweep only sees the current parents' previews;
  4. the old parent workers and `os-preview-*` resources stay until the owner deletes them (Workers
     are never deleted as part of source cleanup).

## Checklist

- [x] `resolvePreviewName`: `pr<n>` for a PR; `previewPullRequestNumber` reads `pr<n>` only _(preview-config.ts; also refuses a name whose resources collide)_
- [x] preview.ts: a PR-numbered run needs no branch name (drop the GitHub branch lookup); workflows
      stop passing `PREVIEW_NAME` for PR runs _(resolveBranch gone; preview-delete.yml drops its pull-requests permission)_
- [x] envs.ts: parents renamed; os parent's fresh resources; `dashBaseUrl` _(os-parent-\* created)_
- [x] start-app.ts: a `preview` build's issuer and app origins are the preview parents _(startAppWorkerConfig "linked" env)_
- [x] preview.ts `deploy-parents` command: the os parent (deploy.ts `--env preview`), then every app
      parent from its `preview` build _(side by side; run from this branch, all six smoke green)_
- [x] `preview-parents.yml`; Main OS e2e's `parent` job removed _(renamed from deploy-preview-parents.yml)_
- [x] app-preview "parent missing → deploy it from the preview config" fallback replaced by an error _(DEPLOY_PARENTS_HINT)_
- [x] sweep: `pr<n>` rules, known-resource guard, table rows _(accountResourceNames)_
- [x] nightly parent reset _(reset-parent; do-reset.ts preview filter + preview_urls on the park)_
- [x] tests, fixtures and docs updated to the new URLs (README, docs/\*.md, skills, comments)
- [ ] resources created, parents deployed from the branch, this PR's preview green under new names _(first two done; pr3091 deployed, suites pending)_

## Not in this task

- Partial deploys (an app-only PR previewing just the app against the parent platform).
- A distinct favicon/title for the parents: `os.iterate-dev-preview.workers.dev` reads as
  production to `deploymentEnvironment` (packages/ui/src/lib/environment-favicon.ts).
- Deleting the old `*-preview` parent workers.

## Implementation log

- 2026-09-24: all six names (`os`, `dash`, …) were free on the dev/preview account.
- Collision found: local dev's R2 bucket is `os-files`, and the CI preview `main` would own
  `os-main-*`. Hence `os-parent-*` for the parent, and accountResourceNames guarding the sweep and
  the naming.
- Throwaway-worker measurements (tmp-tombstone-probe-0924, tmp-park-probe-0924, both deleted):
  - a tombstone deploy on the parent deleted the parent's Counter data; an existing preview's data
    survived on the same namespace id; redeploying the preview and creating new ones worked;
  - a brand-new preview bound a class (`Extra`) its parent never had;
  - do-reset.ts as it was failed on a parent with previews: each preview's namespace counted as the
    parent's, `deleted_classes: ["Counter","Counter"]`, Cloudflare 10021. The listing marks a
    preview's namespaces with `preview: {name, slug}`;
  - the parked config's `workers_dev: false` with `preview_urls` unset took every preview offline
    (404, 1042) until the redeploy; `preview_urls: true` kept them serving and writable.
- Real run of `pnpm preview reset-parent` on `os` at 19:54:42–19:55:31 UTC with pr3091 live and its
  suites running: pr3091-os and pr3091-dash 200 on every 3 s poll; the parent 404 for ~21 s while
  parked; parent namespaces fresh (ControlPlane 935fa5d9 → c8087bcd), pr3091's unchanged (0af227bd).
