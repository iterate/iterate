# iterate

## Prerequisites

- [Depot CLI](https://depot.dev/docs/cli/installation) for fast Docker builds with shared caching:
  ```bash
  brew install depot/tap/depot
  depot login
  ```

## Quick Start

```bash
pnpm install
pnpm docker:up
pnpm os db:migrate
docker buildx create --name iterate --driver docker-container --use
pnpm sandbox build
pnpm dev
```

## Repository Structure

- `apps/os/` - Primary application (React + Cloudflare Workers)
- `apps/daemon/` - Local daemon for durable streams and agent orchestration
- `apps/iterate-com` - iterate.com website
- `docs/` - Detailed documentation and patterns

## Development Commands

```bash
pnpm dev          # Run auth + os together
pnpm os dev       # Run apps/os only
pnpm --dir apps/auth dev  # Run apps/auth only
pnpm daemon dev   # Run apps/daemon only
pnpm test         # Run all tests
pnpm typecheck    # Type check all packages
pnpm lint         # Lint and fix
pnpm format       # Format code
```

## Cloudflare App Deployments

Think of every new-style Cloudflare deploy as selecting two axes:

- Doppler project: app/service dimension, such as `os2` or `semaphore`
- Doppler config: environment config dimension, such as `dev_jonas_2`, `preview_2`, or `prd`

For new-style Cloudflare apps (`agents`, `codemode`, `example`,
`ingress-proxy`, `os2`, and `semaphore`), local deployed dev, PR previews, and
main/prod deploys all use the same primitive:

```bash
cd apps/<app>
doppler run --project <app> --config <environment-config> -- pnpm exec tsx ./alchemy.run.ts
```

The difference is orchestration. Local deployed dev selects a personal dev
config. PR previews lease `data.dopplerConfig` from Semaphore and deploy
affected apps plus dependencies. `main` deploys use generated per-app workflows
with `prd`. PR previews are not promoted to production.

Environment config leases for PR previews are source-code seeded from
`scripts/preview/preview-inventory.ts`. Each live Semaphore resource has:

- type: `environment-config-lease`
- slug: `preview-2`, `preview-3`, etc.
- data: `{ "dopplerConfig": "preview_2" }`, etc.

To create or repair environment config leases for PR previews:

1. Add or confirm the lease in `scripts/preview/preview-inventory.ts`.
2. Ensure every preview-managed app that may use that lease has the matching
   Doppler config, for example `preview_9`, plus any required Cloudflare
   route/domain config.
3. Reconcile the live Semaphore inventory from source:

```bash
doppler run --project semaphore --config prd -- pnpm --dir apps/semaphore seed:environment-config-leases
doppler run --project os --config prd -- pnpm preview status
```

The seed is exact for `environment-config-lease`: missing resources are created
and drifted resources are replaced. Only add leases whose Doppler configs and
Cloudflare domains exist in the right accounts. To expand capacity, first add
the slot to the source inventory and provision matching Doppler configs and
app-specific Cloudflare prerequisites. See
`docs/cloudflare-preview-environments.md` for the full lifecycle.

## Cloudflare Tunnels

Expose local dev servers via public URLs (useful for webhooks, OAuth callbacks):

```bash
DEV_TUNNEL=1 pnpm dev        # → {app}-dev-{ITERATE_USER}.dev.iterate.com
DEV_TUNNEL=bob pnpm dev      # → bob.dev.iterate.com (custom, no stage/app suffix)
DEV_TUNNEL=0 pnpm dev        # disabled (also: false, or unset)
```

## Sandbox Providers

See `sandbox/README.md` for provider strategy, image tagging, and CI flow.
Fly is the primary deployment provider; Daytona is supported for one-off manual testing only.
