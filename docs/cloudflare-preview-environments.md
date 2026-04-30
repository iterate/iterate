# Cloudflare Preview Environments

Preview environments for `agents`, `codemode`, `example`, `events`, `os2`, `semaphore`, and `ingress-proxy` are ordinary Semaphore resource pools plus one repo-root preview router.

## Naming

- resource type: app-specific pool name like `example-preview-environment`
- resource slug: worker identity like `example-preview-1`
- Alchemy stage: config-derived stage like `preview_1` (slugified by apps into resource names like `preview-1`)
- Doppler config: branch config like `preview_1`
- public URL: usually `https://<slug>.iterate.workers.dev`, unless that app's `preview_N` Doppler config sets routed host config

The resource slug is the canonical preview environment identifier. Every other name is derived from it.

Preview slot configs are named `preview_1`, `preview_2`, etc. `ALCHEMY_STAGE` is inherited from `_shared` as `${DOPPLER_CONFIG}`. Preview deploy commands do not set `ALCHEMY_STAGE` themselves; the selected Doppler config is the source of truth.

For `events`, preview slots use routed custom hosts from the slot Doppler config:

- `events-preview-1.iterate.com`
- `*.events-preview-1.iterate.com`

For `os2`, each preview slot gets a dashboard host under
`iterate-preview-N.com` and project/MCP hosts under `iterate-preview-N.app`
(see `docs/os2-environments.md`):

- `os2.iterate-preview-N.com` (dashboard)
- `*.iterate-preview-N.app` (project subdomains and `/mcp`)

For `agents`, `codemode`, `example`, `semaphore`, and `ingress-proxy`,
preview slot `APP_CONFIG_BASE_URL` values use the Worker URL directly:

- `https://<app>-preview-N.iterate-dev-stg.workers.dev`

`workers.dev` routes are assigned automatically from the Worker name, so
`IterateApp` deliberately does not create Cloudflare Route/DNS resources for
those hostnames.

That means host-sensitive preview features can behave like preview/production instead of being limited to a plain `workers.dev` host.

## Source Of Truth

- Semaphore `resources` stores the static preview pool inventory and generic leases
- the managed PR body preview section stores the current per-app preview entry for that PR
- there is no preview-specific database state in Semaphore
- Doppler stores per-slot deploy config and inherited `ALCHEMY_STAGE`

## Semaphore Token

The preview router talks to Semaphore with a bearer token. In normal CI and operator commands, run it through `doppler run --project os --config prd`; the router reads `SEMAPHORE_API_TOKEN` when present and otherwise falls back to `APP_CONFIG_SHARED_API_SECRET`.

To use Semaphore directly, export the same token as `SEMAPHORE_API_TOKEN` or run from a Doppler config that exposes `APP_CONFIG_SHARED_API_SECRET`:

```bash
doppler run --project os --config prd -- pnpm preview status
doppler run --project semaphore --config prd -- pnpm seed:preview-pool
```

Do not paste the token into scripts or docs. The Semaphore UI calls it the operator token; it is the same shared API secret used for authenticated resource mutations.

## Lifecycle

1. A shared PR preview workflow runs the repo-local Iterate CLI against `./scripts/preview/router.ts`.
2. The preview router reads the managed PR body preview section. If the app already has a recorded preview, it destroys it first.
3. The preview procedures acquire a fresh generic Semaphore lease from the app-specific preview pool.
4. It derives the Doppler config, Alchemy stage, and public URL from the leased slug.
5. It deploys with `doppler run --project <app> --config preview_N -- pnpm alchemy:up`. If no routed host config is set, the preview stays `workers.dev`-only; if routed hosts are configured, Alchemy creates the matching Cloudflare worker routes for that preview slot. Then it runs the app's network preview tests against the live URL and updates the managed PR body preview section.
6. On PR close, the same workflow runs `preview cleanup`.
7. The preview router reads the same PR body entry, runs `pnpm alchemy:down`, releases the generic Semaphore lease, and updates the section.

## Operational Notes

- Preview inventory is provisioned explicitly with `apps/semaphore` `seed-cloudflare-preview-environment-pool`.
- Doppler `preview_N` configs are also an explicit rollout precondition.
- New preview-enabled apps must be added to `scripts/preview/apps.ts`, seeded into Semaphore, and given `preview_1` through `preview_10` configs in their Doppler project.
- CI workflows only invoke the shared preview local-router commands; they do not parse or render preview state directly.
- The app manifest for paths, Doppler project names, preview pool types, and test commands lives in `scripts/preview/apps.ts`.
- The preview router and procedures live in `scripts/preview/router.ts` and `scripts/preview/preview.ts`.
- Preview leases are deliberately long-lived in v1 and are released explicitly on cleanup.
- Deleting the managed PR body preview section is treated as state loss. A later sync can create a fresh preview while the previous environment may linger until cleanup or later slot reuse.
- `events` preview runs the deployed-worker smoke suites rather than the slowest stream propagation suite, which remains available under the full app e2e command.
- `events` preview slot configs currently use custom routed hosts under `iterate.com`, so keep the slot DNS + wildcard DNS records (`events-preview-N.iterate.com` and `*.events-preview-N.iterate.com`) in place before expecting preview sync to pass readiness on those hosts.
- `semaphore` preview runs the deployed-worker auth, CRUD, and contract-client checks rather than the longest wait-path contention test, which remains available under the full app e2e command.
- `ingress-proxy` preview runs the management API e2e suite only. The full custom-host proxy suite still needs a routed hostname topology rather than an isolated `workers.dev` preview URL.
- Manual lifecycle:
  `doppler run --project os --config prd -- pnpm preview sync --app example`
  `doppler run --project os --config prd -- pnpm preview cleanup --app example`
