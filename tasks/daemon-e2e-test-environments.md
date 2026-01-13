---
state: todo
priority: medium
size: medium
tags:
  - testing
  - daemon
  - infrastructure
---

# Daemon E2E Tests Across Multiple Environments

We should be able to run full Playwright-based e2e tests against the daemon app in multiple environments:

1. **Local dev server** (`pnpm dev` from `apps/daemon`)
2. **Local Docker container** (via `local-docker` provider)
3. **Daytona sandboxes** (production-like environment)

## Current State

- `apps/os/sandbox/local-docker.test.ts` has basic integration tests that verify the Docker container works (s6, iterate-server, tmux, PTY endpoints)
- These tests use `expect.poll()` and direct HTTP/WebSocket calls rather than Playwright
- No proper Playwright e2e tests exist for the daemon UI

## Goals

1. Create a Playwright test suite for daemon that covers:
   - Agent creation and management
   - Terminal/ghostty interaction (typing commands, seeing output)
   - tRPC API interactions
   - Navigation and routing

2. Make these tests runnable against any of the three environments above by parameterizing the base URL

3. Consider whether to:
   - Add a new `e2e/daemon/` directory similar to `e2e/os/`
   - Or extend the existing `apps/os/sandbox/local-docker.test.ts` with Playwright

## Implementation Notes

- The ghostty terminal uses WebSocket connections to `/api/pty/ws`
- Tmux sessions are created via tRPC (`ensureTmuxSession`, `listTmuxSessions`)
- The daemon UI is at the root `/` path, not nested under a route prefix
- For Docker containers, need to wait for iterate-server to be healthy before running tests

## Related Files

- `apps/daemon/` - The daemon app
- `apps/os/sandbox/local-docker.test.ts` - Existing integration tests
- `apps/os/sandbox/Dockerfile` - Container image definition
- `e2e/` - Existing e2e test infrastructure
