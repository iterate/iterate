# E2E Refactor Progress

## Completed & Verified

### Step 1: Shared vitest e2e infrastructure in `packages/shared`

- Created `packages/shared/src/test-support/vitest-e2e/vitest-artifacts.ts` — artifact paths, console capture, result writing
- Created `packages/shared/src/test-support/vitest-e2e/index.ts` — barrel export
- No `test.extend` — `onTestFailed`/`onTestFinished` available on normal test context
- Added `./test-support/vitest-e2e` export to `packages/shared/package.json`

### Step 2: Event helpers

- Created `apps/agents/e2e/test-support/events-stream.ts` — `createEventsHelpers()` with append, waitForEvent, client, streamViewerUrl
- Still uses polling (not SSE) — matches old behavior. SSE upgrade deferred.

### Step 3: `setupE2E(ctx)` function

- Created `apps/agents/e2e/test-support/e2e-test.ts` — plain function, no `test.extend`
- Created `apps/agents/e2e/test-support/provide-keys.ts` — config-safe constants

### Step 4: Updated vitest.config.ts

- Provide keys, `onConsoleLog` capture, tags, `fileParallelism: true`
- Created `apps/agents/e2e/vitest.shims.d.ts`

### Step 5: `createLocalDevServer` factory

- `apps/agents/e2e/test-support/create-local-dev-server.ts`

### Step 6: forwarded-events ✅ PASSED

- `local-dev-server` + `live-internet` — 15.9s

### Step 7: `createMockInternet` factory

- `apps/agents/e2e/test-support/create-mock-internet.ts`

### Step 8: Codemode tests

- iterate-agent ✅ PASSED (HAR replay, 16.8s)
- iterate-agent-mcp ✅ PASSED (HAR replay, 17.2s)
- iterate-agent-mixed-codemode ❌ FAILED — WIP `agent-processor.ts` changes break the codemode script
  (`awaitEvent(() => ...)` is new syntax under development). Not an infrastructure issue.

### Step 9: Agent-loop ✅ PASSED

- `local-dev-server` + `live-internet` + `slow` — 23.0s

### Step 10: Remaining tests

- external-egress-proxy ✅ PASSED (14.0s)
- runtime-smoke — skipped (needs `AGENTS_E2E_RUNTIME_SMOKE=1` + `AGENTS_BASE_URL`)

### Step 11: Cleanup ✅

- Deleted old helpers, moved HARs, simplified scripts

### Artifacts ✅

- `result.json` written for each test (pass and fail) with state + errors + timestamps
- `vitest-output.log` captures console output per test
- Temp dirs at `/tmp/agents-e2e-*/`

### All checks pass ✅

- `pnpm typecheck` (shared + agents)
- `pnpm lint`
- `pnpm format`

## Remaining

### Step 12: `createEphemeralWorker` ✅ PASSED

- Created `apps/agents/e2e/test-support/create-ephemeral-worker.ts`
- Created `apps/agents/e2e/vitest/ephemeral-worker-smoke.e2e.test.ts` — 2 tests sharing one deploy
  - `hello procedure` ✅ (0.5s)
  - `websocket codemode with builtin + events OpenAPI + fetch` ✅ (7.3s)
- Total: 52s (deploy ~40s + tests ~8s + teardown ~4s)
- Requires `ALCHEMY_STATE_TOKEN` (now in `_shared` doppler config)
- Added `pnpm cli deploy-ephemeral` oRPC command in `scripts/router.ts`
- Note: forwarded-events (webhook) doesn't work on deployed workers — `/api/events-forwarded` is 404.
  That route only exists in local dev mode (TanStack Start dev server).

### Mixed-codemode fix

The `iterate-agent-mixed-codemode` test failure is from WIP changes to `agent-processor.ts`
(the codemode script uses `awaitEvent(() => ...)` which errors). This needs fixing in the
agent code, not the test infrastructure. Once the agent code is stable, either:

- Fix the codemode script, or
- Re-record the HAR with `pnpm test:e2e:record`

### Runtime smoke

Not tested — opt-in, requires deployed AGENTS_BASE_URL. Should work since it's a
trivial rewrite (just import change).
