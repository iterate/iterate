# Cloudflare Preview Environments

Preview environments for `codemode`, `example`, `events`, `semaphore`, and `ingress-proxy` are ordinary Semaphore resource pools plus one repo-root preview router.

## Naming

- resource type: app-specific pool name like `example-preview-environment`
- resource slug: worker identity like `example-preview-1`
- Alchemy stage: slot stage like `preview-1`
- Doppler config: branch config like `stg_1`
- workers.dev hostname: `example-preview-1.iterate.workers.dev`

The resource slug is the canonical preview environment identifier. Every other name is derived from it.

## Source Of Truth

- Semaphore `resources` stores the static preview pool inventory and generic leases
- the sticky GitHub PR comment stores the current per-app preview entry for that PR
- there is no preview-specific database state in Semaphore

## Lifecycle

1. A PR workflow for an affected app runs the repo-local Iterate CLI against `./scripts/preview/router.ts`.
2. The preview router reads the sticky PR comment. If the app already has a recorded preview, it destroys it first.
3. The preview procedures acquire a fresh generic Semaphore lease from the app-specific preview pool.
4. It derives `stg_N`, `preview-N`, and the public URL from the leased slug.
5. It deploys with `pnpm alchemy:up`, runs the app’s network preview tests against the live URL, and updates the sticky PR comment.
6. On PR close, the cleanup workflow runs the same preview router with `preview cleanup`.
7. The preview router reads the same comment entry, runs `pnpm alchemy:down`, releases the generic Semaphore lease, and updates the comment.

## Operational Notes

- Preview inventory is provisioned explicitly with `apps/semaphore` `seed-cloudflare-preview-environment-pool`.
- Doppler `stg_N` configs are also an explicit rollout precondition.
- CI workflows only invoke the shared preview local-router commands; they do not parse or render preview comment state directly.
- The app manifest for paths, Doppler project names, preview pool types, and test commands lives in `scripts/preview/apps.ts`.
- The preview router and procedures live in `scripts/preview/router.ts` and `scripts/preview/preview.ts`.
- Preview leases are deliberately long-lived in v1 and are released explicitly on cleanup.
- Use `doppler run --project os --config prd -- pnpm preview status` from the repo root to inspect live preview pool inventory and lease state.
- Manual lifecycle:
  `doppler run --project os --config prd -- pnpm preview sync --app example`
  `doppler run --project os --config prd -- pnpm preview cleanup --app example`
