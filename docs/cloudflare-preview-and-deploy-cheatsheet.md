# Cloudflare Preview And Deploy Cheat Sheet

## Cheat sheet

- In scope apps: `agents`, `codemode`, `example`, `events`, `os2`, `semaphore`, `ingress-proxy`
- PR previews are owned by one workflow: `Cloudflare Previews`
- Production deploys are owned by per-app workflows:
  - `Deploy Codemode`
  - `Deploy Example`
  - `Deploy Events`
  - `Deploy Semaphore`
  - `Deploy Ingress Proxy`
- Preview state lives in the managed PR body section, not in PR comments
- Semaphore stores shared preview environment inventory and leases
- Doppler `preview_N` configs back preview slots
- `_shared/preview` sets `ALCHEMY_STAGE=${DOPPLER_CONFIG}`, so the selected `preview_N` config determines the Alchemy stage
- Doppler `prd` config backs real deploys

## Most useful commands

```bash
# inspect preview environment state / leases
doppler run --project os --config prd -- pnpm preview status

# create or refresh a PR preview; affected apps and dependencies are selected automatically
doppler run --project os --config prd -- pnpm preview sync --pull-request-number 1234

# deploy every preview-managed app even if the PR did not touch all of them
doppler run --project os --config prd -- pnpm preview sync --pull-request-number 1234 --force true

# split preview into explicit phases
doppler run --project os --config prd -- pnpm preview deploy --pull-request-number 1234
doppler run --project os --config prd -- pnpm preview test --pull-request-number 1234
doppler run --project os --config prd -- pnpm preview cleanup --pull-request-number 1234

# manual prod deploy from GitHub Actions
gh workflow run "Deploy Events" --ref main -f ref=main -f stage=prd
```

## Mental model

- Previews are temporary deploys into a leased `preview_N` Doppler config.
- The Semaphore lease gives the config dimension, not an app-specific pool.
- Production deploys are plain `prd` deploys for each app.
- Previews and production are deliberately separate:
  - PRs never use the per-app prod deploy workflows
  - `main` deploys never use the preview router

## How previews work

1. The shared `Cloudflare Previews` workflow runs on PRs for the in-scope apps.
2. It runs the repo-local preview CLI in `scripts/preview/router.ts`.
3. The CLI reads the managed preview section from the PR body.
4. It renews or reacquires the existing shared preview lease when possible.
5. If reuse fails, it acquires any available `cloudflare-preview-environment`.
6. It reads `data.dopplerConfig` from the leased Semaphore resource.
7. It deploys affected apps and explicit dependencies with that same Doppler config.
8. It records each app result in the PR body. If one app fails, the overall preview is unhealthy and the lease is kept.
9. On PR close, cleanup tears down recorded apps and releases the shared lease only after successful teardown.

## Semaphore token

Preview commands need a Semaphore bearer token. The repo-root preview router gets it from `SEMAPHORE_API_TOKEN`, falling back to `APP_CONFIG_SHARED_API_SECRET`.

For normal operator work, use the `os` production Doppler config:

```bash
doppler run --project os --config prd -- pnpm preview status
doppler run --project os --config prd -- pnpm preview sync --pull-request-number 1234
```

For Semaphore maintenance itself, use the `semaphore` production Doppler config:

```bash
doppler run --project semaphore --config prd -- pnpm seed:preview-pool
```

The Semaphore UI labels this as an operator token. It is the same shared API secret; never commit it or paste the value into a PR.

## How production deploys work

1. Each app has its own generated deploy workflow.
2. `push` to `main` for that app’s paths deploys automatically to `prd`.
3. `workflow_dispatch` can deploy `prd` manually from `main`.
4. The workflow resolves the public URL from the app’s Doppler `WORKER_ROUTES` secret.
5. The actual deploy happens in the app directory with `doppler run -- pnpm alchemy:up`.

## What to know before touching this

- The preview app registry is `scripts/preview/apps.ts`.
- The shared Semaphore seed inventory is `scripts/preview/preview-inventory.ts`.
- The preview CLI/router is `scripts/preview/router.ts`.
- Preview lifecycle logic is `scripts/preview/preview.ts`.
- Preview PR-body rendering/state is `scripts/preview/state.ts`.
- The shared preview workflow is `.github/workflows/cloudflare-previews.yml`.
- The per-app deploy workflow generator is `.github/ts-workflows/utils/cloudflare-app-workflow.ts`.
- The generated per-app deploy workflows live in `.github/workflows/deploy-*.yml`.

## Failure modes / footguns

- Deleting the managed preview section from the PR body is treated as state loss.
- If the PR body state is lost, the next sync can create a fresh lease and an old preview may linger until later cleanup or slot reuse.
- Preview jobs that mutate the PR body must stay serialized per PR.
- Preview tests are intentionally narrower than the slowest full app e2e suites.
- Preview deploys do not override `ALCHEMY_STAGE`; route-driven previews should be configured in the app's `preview_N` Doppler configs.
- The temporary dependency graph in `scripts/preview/apps.ts` exists only until app manifests or contracts can express cross-app deploy dependencies.
- `example` currently has no real network e2e cases; its `test:e2e` command passes with no tests.

## Prod verification commands

```bash
EXAMPLE_BASE_URL=https://example.iterate.com pnpm --dir apps/example test:e2e
EVENTS_BASE_URL=https://events.iterate.com pnpm --dir apps/events test:e2e:preview
doppler run --project semaphore --config prd -- env SEMAPHORE_BASE_URL=https://semaphore.iterate.com pnpm --dir apps/semaphore test:e2e:preview
doppler run --project ingress-proxy --config prd -- env INGRESS_PROXY_BASE_URL=https://ingress.iterate.com pnpm --dir apps/ingress-proxy test:e2e:preview
```
