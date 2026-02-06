---
state: todo
priority: medium
size: medium
tags:
  - testing
  - daemon
  - infrastructure
---

# Daemon Spec Tests Across Multiple Environments

We should be able to run full Playwright-based spec tests against the daemon app in multiple environments:

1. **Local dev server** (`pnpm dev` from `apps/daemon`)
2. **Local Docker container** (via `local-docker` provider)
3. **Daytona sandboxes** (production-like environment)

## Current State

- `apps/os/sandbox/test/daemon-in-sandbox.test.ts` and `sandbox-without-daemon.test.ts` have basic integration tests that verify the Docker container works (s6, iterate-daemon, PTY endpoints)
- These tests use `expect.poll()` and direct HTTP/WebSocket calls rather than Playwright
- No proper Playwright spec tests exist for the daemon UI

## Goals

1. Create a Playwright test suite for daemon that covers:
   - Agent creation and management
   - Terminal/ghostty interaction (typing commands, seeing output)
   - tRPC API interactions
   - Navigation and routing

2. Make these tests runnable against any of the three environments above by parameterizing the base URL

3. Consider whether to:
   - Add a new `spec/daemon/` directory similar to `spec/`
   - Or extend the existing `apps/os/sandbox/test/` tests with Playwright

## Implementation Notes

- The ghostty terminal uses WebSocket connections to `/api/pty/ws`
- Terminal sessions use WebSocket PTY connections
- The daemon UI is at the root `/` path, not nested under a route prefix
- For Docker containers, need to wait for iterate-daemon to be healthy before running tests

## Related Files

- `apps/daemon/` - The daemon app
- `apps/os/sandbox/test/` - Existing integration tests
- `apps/os/sandbox/Dockerfile` - Container image definition
- `spec/` - Existing spec test infrastructure
