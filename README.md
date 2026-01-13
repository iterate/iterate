# iterate

## Quick Start

```bash
pnpm install
pnpm docker:up
pnpm os2 db:migrate
pnpm os2 dev
```

## Repository Structure

- `apps/os2/` - Primary application (React + Cloudflare Workers)
- `apps/daemon/` - Local daemon for durable streams and agent orchestration
- `apps/iterate-com` - iterate.com website
- `docs/` - Detailed documentation and patterns

## Development Commands

```bash
pnpm dev          # Run all apps in parallel
pnpm os2 dev      # Run apps/os2 only
pnpm daemon dev   # Run apps/daemon only
pnpm test         # Run all tests
pnpm typecheck    # Type check all packages
pnpm lint         # Lint and fix
pnpm format       # Format code
```
