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

For new-style Cloudflare apps (`agents`, `codemode`, `example`,
`ingress-proxy`, `os2`, and `semaphore`), deployment is one operation:

```bash
doppler run --project <app> --config <environment-config> -- pnpm exec tsx ./alchemy.run.ts
```

The Doppler project is the app/service dimension. The Doppler config is the
environment config dimension: `prd`, `preview_1`, `dev_jonas_2`, and so on.
`main` deploys use the `prd` config through generated per-app deploy workflows.
PR previews are separate deploys: the `Cloudflare Previews` workflow leases a
numbered config from Semaphore, deploys affected apps into that same config, and
cleans those deploys up on PR close. PR previews are not promoted to production.

Environment config leases for PR previews are source-code seeded from
`scripts/preview/preview-inventory.ts`. Each live Semaphore resource has:

- type: `environment-config-lease`
- slug: `preview-1`, `preview-2`, etc.
- data: `{ "dopplerConfig": "preview_1" }`, etc.

To create or repair the live Semaphore inventory after adding an available
preview config/domain pair:

```bash
doppler run --project semaphore --config prd -- pnpm --dir apps/semaphore seed:environment-config-leases
doppler run --project os --config prd -- pnpm preview status
```

Only add slots whose Doppler configs and Cloudflare domains exist in the right
accounts. See `docs/cloudflare-preview-environments.md` for the full lifecycle.

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
