# Daemon Agent Rules

This directory contains the local daemon for durable streams and agent orchestration.

## Architecture Overview

The daemon orchestrates AI coding agents (OpenCode, Claude Code, Pi) through **durable event streams**. Each agent has its own stream. Harness adapters react to stream events and call harness APIs.

See `docs/daemon-architecture.md` for full architecture documentation.

## Key Directories

- `durable-streams/` - Event stream implementation with append/subscribe/get-history operations
- `agent-wrapper/` - Harness adapters for various AI coding agents
- `pi/` - Pi-specific agent integration
- `ui/` - Local development UI components

## Core Pattern

A durable stream has exactly three operations:

1. **Subscribe** — get events as they arrive (with offset-based resumption)
2. **Get history** — read past events from a given offset
3. **Append** — add new events to the stream

## Development

```bash
pnpm daemon dev      # Run the daemon
pnpm daemon test     # Run tests
pnpm daemon test:e2e # Run e2e tests
```

## TypeScript Conventions

- Use Effect for async operations and error handling
- Use TypeBox for schema definitions
- Tests colocated as `*.test.ts` files
- Prefer inline snapshots for test assertions

## Event Naming

- External events: source-based (`slack:*`, `github:*`), past-tense verbs
- Action events: `action:*:called` suffix (things we want to happen)
- Wrapped harness events: generic `event-received` type, native format in `payload`
- Colon separator: URL-safe, clear hierarchy
