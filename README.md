# iterate

## Important: apps/os is deprecated

**`apps/os` is deprecated.** `apps/os2` is the new direction for development.

In due course, `apps/os` will be removed entirely and `apps/os2` will take its place. Until then:

- New features should be built in `apps/os2`
- `apps/os` remains deployable but should not receive new development
- See `apps/os2/` for setup and development instructions

## Quick Start

```bash
pnpm install
pnpm docker:up
pnpm os2 db:migrate
pnpm os2 dev
```

## Repository Structure

- `apps/os2/` - Primary application (React + Cloudflare Workers)
- `apps/daemon2/` - Local daemon for durable streams and agent orchestration
- `apps/os/` - **DEPRECATED** - Legacy application
- `estates/` - Example configurations and customizations
- `vibe-rules/` - Coding agent rules (generates AGENTS.md, CLAUDE.md)

## Development Commands

```bash
pnpm dev          # Run all apps in parallel
pnpm os2 dev      # Run apps/os2 only
pnpm daemon2 dev  # Run apps/daemon2 only
pnpm test         # Run all tests
pnpm typecheck    # Type check all packages
pnpm lint         # Lint and fix
pnpm format       # Format code
```
