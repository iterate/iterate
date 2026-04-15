# Cloudflare Preview And Deploy Cheat Sheet

## Cheat sheet

- In scope apps: `codemode`, `example`, `events`, `semaphore`, `ingress-proxy`
- PR previews are owned by one workflow: `Cloudflare Previews`
- Production deploys are owned by per-app workflows:
  - `Deploy Codemode`
  - `Deploy Example`
  - `Deploy Events`
  - `Deploy Semaphore`
  - `Deploy Ingress Proxy`
- Preview state lives in the managed PR body section, not in PR comments
- Semaphore stores preview pool inventory and leases
- Doppler `stg_N` configs back preview slots
- Doppler `prd` config backs real deploys

## Most useful commands

```bash
# inspect preview pool state / leases
doppler run --project os --config prd -- pnpm preview status

# create or refresh one preview for a PR
doppler run --project os --config prd -- pnpm preview sync --app events --pull-request-number 1234

# create a preview even if the PR did not touch that app
doppler run --project os --config prd -- pnpm preview sync --app events --pull-request-number 1234 --force true

# split preview into explicit phases
doppler run --project os --config prd -- pnpm preview deploy --app events --pull-request-number 1234
doppler run --project os --config prd -- pnpm preview test --app events --pull-request-number 1234
doppler run --project os --config prd -- pnpm preview cleanup --app events --pull-request-number 1234

# manual prod deploy from GitHub Actions
gh workflow run "Deploy Events" --ref main -f ref=main -f stage=prd
```

## Mental model

- Previews are temporary `stg_N` deploys attached to leased Semaphore slots.
- Production deploys are plain `prd` deploys for each app.
- Previews and production are deliberately separate:
  - PRs never use the per-app prod deploy workflows
  - `main` deploys never use the preview router

## How previews work

1. The shared `Cloudflare Previews` workflow runs on PRs for the in-scope apps.
2. It runs the repo-local preview CLI in `scripts/preview/router.ts`.
3. The CLI reads the managed preview section from the PR body.
4. It acquires a Semaphore lease from the app’s preview pool.
5. It derives the preview slot names from the leased slug:
   - resource slug like `events-preview-1`
   - Doppler config like `stg_1`
   - Alchemy stage like `preview-1`
   - public URL from that slot's deploy shape (for example `https://events-preview-1.iterate.com` for `events`, or `https://example-preview-1.iterate.workers.dev` for workers.dev-only apps)
6. It deploys the app with the selected `stg_N` Doppler config intact, runs that app’s preview e2e command, and writes the result back into the PR body.
7. On PR close, the same workflow runs cleanup and releases the lease.

## How production deploys work

1. Each app has its own generated deploy workflow.
2. `push` to `main` for that app’s paths deploys automatically to `prd`.
3. `workflow_dispatch` can deploy `prd` manually from `main`.
4. The workflow resolves the public URL from the app’s Doppler `WORKER_ROUTES` secret.
5. The actual deploy happens in the app directory with `doppler run -- pnpm alchemy:up`.

## What to know before touching this

- The preview app registry is `scripts/preview/apps.ts`.
- The preview CLI/router is `scripts/preview/router.ts`.
- Preview lifecycle logic is `scripts/preview/preview.ts`.
- Preview PR-body rendering/state is `scripts/preview/state.ts`.
- The shared preview workflow is `.github/workflows/cloudflare-previews.yml`.
- The per-app deploy workflow generator is `.github/ts-workflows/utils/cloudflare-app-workflow.ts`.
- The generated per-app deploy workflows live in `.github/workflows/deploy-*.yml`.

## Failure modes / footguns

- Deleting the managed preview section from the PR body is treated as state loss.
- If the PR body state is lost, the next sync can create a fresh preview and an old preview may linger until later cleanup or slot reuse.
- Preview jobs that mutate the PR body must stay serialized per PR.
- Preview tests are intentionally narrower than the slowest full app e2e suites.
- Preview deploys do not blank `WORKER_ROUTES`; route-driven previews should be configured in the app's `stg_N` Doppler configs.
- `example` currently has no real network e2e cases; its `test:e2e` command passes with no tests.

## Prod verification commands

```bash
CODEMODE_BASE_URL=https://codemode.iterate.com DOPPLER_PROJECT=ai-engineer-workshop DOPPLER_CONFIG=dev_jonas pnpm --dir apps/codemode test:e2e:doppler
EXAMPLE_BASE_URL=https://example.iterate.com pnpm --dir apps/example test:e2e
EVENTS_BASE_URL=https://events.iterate.com pnpm --dir apps/events test:e2e:preview
doppler run --project semaphore --config prd -- env SEMAPHORE_BASE_URL=https://semaphore.iterate.com pnpm --dir apps/semaphore test:e2e:preview
doppler run --project ingress-proxy --config prd -- env INGRESS_PROXY_BASE_URL=https://ingress.iterate.com pnpm --dir apps/ingress-proxy test:e2e:preview
```
