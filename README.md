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
pnpm docker:build
pnpm os dev
```

## Repository Structure

- `apps/os/` - Primary application (React + Cloudflare Workers)
- `apps/daemon/` - Local daemon for durable streams and agent orchestration
- `apps/iterate-com` - iterate.com website
- `docs/` - Detailed documentation and patterns

## Development Commands

```bash
pnpm dev          # Run all apps in parallel
pnpm os dev       # Run apps/os only
pnpm daemon dev   # Run apps/daemon only
pnpm test         # Run all tests
pnpm typecheck    # Type check all packages
pnpm lint         # Lint and fix
pnpm format       # Format code
```

## Cloudflare Tunnels

Expose local dev servers via public URLs (useful for webhooks, OAuth callbacks):

```bash
DEV_TUNNEL=1 pnpm dev        # → {app}-dev-{ITERATE_USER}.dev.iterate.com
DEV_TUNNEL=bob pnpm dev      # → bob.dev.iterate.com (custom, no stage/app suffix)
DEV_TUNNEL=0 pnpm dev        # disabled (also: false, or unset)
```

## Daytona snapshots

Build a daytona snapshot and write DAYTONA_SNAPSHOT_NAME to your daytona config (needs `brew install daytonaio/cli/daytona`)

```bash
pnpm build:daytona
```
