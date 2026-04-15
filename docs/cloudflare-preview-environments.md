# Cloudflare Preview Environments

Preview environments for `example`, `events`, `semaphore`, and `ingress-proxy` are ordinary Semaphore resource pools plus one repo-root preview router.

## Naming

- resource type: app-specific pool name like `example-preview-environment`
- resource slug: worker identity like `example-preview-1`
- Alchemy stage: slot stage like `preview-1`
- Doppler config: branch config like `stg_1`
- public URL: usually `https://<slug>.iterate.workers.dev`, unless that app's `stg_N` Doppler config sets `WORKER_ROUTES`

The resource slug is the canonical preview environment identifier. Every other name is derived from it.

For `events`, preview slots now use routed custom hosts from the slot Doppler config:

- `events-preview-1.iterate.com`
- `*.events-preview-1.iterate.com`

That means host-sensitive preview features can behave like staging/production instead of being limited to a plain `workers.dev` host.

## Source Of Truth

- Semaphore `resources` stores the static preview pool inventory and generic leases
- the managed PR body preview section stores the current per-app preview entry for that PR
- there is no preview-specific database state in Semaphore

## Lifecycle

1. A shared PR preview workflow runs the repo-local Iterate CLI against `./scripts/preview/router.ts`.
2. The preview router reads the managed PR body preview section. If the app already has a recorded preview, it destroys it first.
3. The preview procedures acquire a fresh generic Semaphore lease from the app-specific preview pool.
4. It derives `stg_N`, `preview-N`, and the public URL from the leased slug.
5. It deploys with `pnpm alchemy:up`, preserving the selected `stg_N` Doppler config's `WORKER_ROUTES`. If `WORKER_ROUTES` is empty, the preview stays `workers.dev`-only; if it is populated, Alchemy creates the matching Cloudflare worker routes for that preview slot. Then it runs the app’s network preview tests against the live URL and updates the managed PR body preview section.
6. On PR close, the same workflow runs `preview cleanup`.
7. The preview router reads the same PR body entry, runs `pnpm alchemy:down`, releases the generic Semaphore lease, and updates the section.

## Operational Notes

- Preview inventory is provisioned explicitly with `apps/semaphore` `seed-cloudflare-preview-environment-pool`.
- Doppler `stg_N` configs are also an explicit rollout precondition.
- CI workflows only invoke the shared preview local-router commands; they do not parse or render preview state directly.
- The app manifest for paths, Doppler project names, preview pool types, and test commands lives in `scripts/preview/apps.ts`.
- The preview router and procedures live in `scripts/preview/router.ts` and `scripts/preview/preview.ts`.
- Preview leases are deliberately long-lived in v1 and are released explicitly on cleanup.
- Deleting the managed PR body preview section is treated as state loss. A later sync can create a fresh preview while the previous environment may linger until cleanup or later slot reuse.
- `events` preview runs the deployed-worker smoke suites rather than the slowest stream propagation suite, which remains available under the full app e2e command.
- `events` preview slot configs currently use custom routed hosts under `iterate.com`, so keep the slot DNS + wildcard DNS records (`events-preview-N.iterate.com` and `*.events-preview-N.iterate.com`) in place before expecting preview sync to pass readiness on those hosts.
- `semaphore` preview runs the deployed-worker auth, CRUD, and contract-client checks rather than the longest wait-path contention test, which remains available under the full app e2e command.
- `ingress-proxy` preview runs the management API e2e suite only. The full custom-host proxy suite still needs a routed hostname topology rather than an isolated `workers.dev` preview URL.
- Use `doppler run --project os --config prd -- pnpm preview status` from the repo root to inspect live preview pool inventory and lease state.
- Manual lifecycle:
  `doppler run --project os --config prd -- pnpm preview sync --app example`
  `doppler run --project os --config prd -- pnpm preview cleanup --app example`
