---
state: in_progress
priority: high
size: medium
---

# Daytona Provider Integration Testing

Validate that sandbox integration tests work against Daytona provider, not just Docker.

## Status Update (2026-02-06)

### What Is Working

1. Daytona daemon integration now passes with snapshot `iterate-sandbox-f3cdc8d42015edec580b96bcb7f3a55d48b4ecc6`.
2. Pidnap client works across snapshot variants:
   - old path style: `/rpc/*`
   - new path style: `/*`
3. Daytona-specific flake reduction shipped:
   - removed noisy debug logs from provider implementation
   - daemon test groups now run sequentially (not concurrent sandbox bursts)
   - readiness waits use pidnap `waitForRunning` with retries
4. Docker restart reliability bug fixed in provider:
   - reset cached pidnap endpoint when container lifecycle changes
   - add hard timeout around Docker `start`/`restart` operations
5. Provider-specific sync coverage now isolated:
   - Docker-only host/worktree sync tests moved to `sandbox/providers/docker/host-sync.test.ts`
   - shared minimal tests remain provider-agnostic

### What Was Broken And Fixed

1. **Core Daytona failure**
   - Symptom: daemon tests timed out on `waitForServiceHealthy`.
   - Root cause: `Sandbox.pidnapClient()` hardcoded `.../rpc`, but tested snapshot served pidnap RPC at root (`/health` and procedures under `/`).
   - Fix: runtime RPC base-path detection in `sandbox/providers/types.ts`.

2. **Post-restart Docker failure**
   - Symptom: after `sandbox.restart()`, pidnap checks failed (`fetch failed`) or hung.
   - Root cause: cached pidnap endpoint contained old remapped host port.
   - Fix: cache reset on lifecycle transitions + Docker lifecycle timeout guard.

3. **Cross-provider test coupling**
   - Symptom: host-sync/worktree assertions polluted Daytona runs.
   - Fix: moved those cases into Docker provider test file.

### Verified Test Matrix (local)

1. Daytona:
   - `test/sandbox-without-daemon.test.ts` PASS
   - `test/provider-base-image.test.ts` PASS
   - `test/daemon-in-sandbox.test.ts` PASS
2. Docker:
   - `providers/docker/host-sync.test.ts` PASS when image is pinned to local build via `SANDBOX_TEST_SNAPSHOT_ID=iterate-sandbox:local`
   - `test/daemon-in-sandbox.test.ts` PASS with same pin (`SANDBOX_TEST_SNAPSHOT_ID=iterate-sandbox:local`)
   - `test/daemon-in-sandbox.test.ts -t "filesystem persists and daemon restarts"` PASS with same pin
3. Repo checks:
   - `pnpm typecheck` PASS
   - `pnpm lint` PASS

### Still Not Great / Risk

1. Docker local runs are very sensitive to image selection.
   - If you omit `SANDBOX_TEST_SNAPSHOT_ID`, tests may use `ghcr.io/iterate/sandbox:local` and produce misleading failures.
2. Docker daemon on this machine intermittently stalls under long, mixed test runs.
   - This caused stale hanging test processes and non-representative flake.
3. Timeout handling is still split across tests and provider code; not fully centralized.

### Coverage Gaps / Tech Debt

1. Base provider abstraction still lacks direct unit tests for:
   - pidnap RPC endpoint detection behavior (`/rpc` vs `/`)
   - cache invalidation semantics across lifecycle calls
2. Docker provider lifecycle timeout paths are untested (no failure-injection test).
3. Some provider contract behavior is integration-tested only, not unit-tested.

### Naming / Env Vars / Abstraction Notes

1. `SANDBOX_TEST_SNAPSHOT_ID` semantics are good (cross-provider), but local Docker ergonomics need one explicit warning in docs/scripts that default image may not be fresh.
2. The base `Sandbox` now owns endpoint detection/caching. This is correct, but restart semantics forced cross-cutting cache invalidation hooks; that coupling should be documented in the base interface comments.
3. Provider split is cleaner after moving Docker-specific sync tests out of shared files.

### External Reviewer Notes: Take/Leave

1. **Taken now**
   - Provider-specific tests separated from cross-provider tests.
   - Reduced over-logging/debug noise in provider code.
2. **Deferred (outside this task)**
   - Egress-proxy regex issue
   - migration safety changes
   - egress-approvals route test suite
   - broad duplication refactors in integrations/workflows

### Next Work To Close Task

1. Add unit tests for `pidnapClient()` endpoint detection + cache reset.
2. Stabilize Docker full-suite run in one command on this machine (currently intermittent daemon pressure issue).
3. Keep CI-driven follow-up separate from this task file once stable.

## Commands Reference

```bash
# Daytona full integration subset
doppler run --config dev -- env RUN_SANDBOX_TESTS=true SANDBOX_TEST_PROVIDER=daytona \
  SANDBOX_TEST_SNAPSHOT_ID=iterate-sandbox-f3cdc8d42015edec580b96bcb7f3a55d48b4ecc6 \
  SANDBOX_TEST_BASE_DAYTONA_SNAPSHOT=iterate-sandbox-f3cdc8d42015edec580b96bcb7f3a55d48b4ecc6 \
  pnpm sandbox test --run \
    test/sandbox-without-daemon.test.ts \
    test/provider-base-image.test.ts \
    test/daemon-in-sandbox.test.ts \
    --maxWorkers=1

# Docker host sync tests (must pin image)
env RUN_SANDBOX_TESTS=true SANDBOX_TEST_PROVIDER=docker \
  SANDBOX_TEST_SNAPSHOT_ID=iterate-sandbox:local \
  pnpm sandbox test --run providers/docker/host-sync.test.ts --maxWorkers=1
```

## Context

PR #891 refactored the sandbox provider abstraction. Test parameterization is now in place so the same tests can run against both Docker and Daytona providers.

### Test Infrastructure (`sandbox/test/helpers.ts`)

```typescript
export const TEST_CONFIG = {
  provider: (process.env.SANDBOX_TEST_PROVIDER ?? "docker") as TestProviderType,
  snapshotId: process.env.SANDBOX_TEST_SNAPSHOT_ID,
  enabled: !!process.env.RUN_SANDBOX_TESTS,
  keepContainers: process.env.KEEP_SANDBOX_CONTAINER === "true",
};

export function createTestProvider(envOverrides?: Record<string, string>): SandboxProvider {
  // Routes to DockerProvider or DaytonaProvider based on TEST_CONFIG.provider
}
```

### Package Scripts (`sandbox/package.json`)

```bash
pnpm sandbox test:docker   # RUN_SANDBOX_TESTS=true SANDBOX_TEST_PROVIDER=docker
pnpm sandbox test:daytona  # doppler run -- RUN_SANDBOX_TESTS=true SANDBOX_TEST_PROVIDER=daytona
```

## Key Files

| File                                          | Purpose                                                |
| --------------------------------------------- | ------------------------------------------------------ |
| `sandbox/test/helpers.ts`                     | Test fixtures, `createTestProvider()`, `withSandbox()` |
| `sandbox/providers/daytona/provider.ts`       | `DaytonaProvider` and `DaytonaSandbox` classes         |
| `sandbox/providers/docker/provider.ts`        | `DockerProvider` and `DockerSandbox` classes           |
| `sandbox/providers/types.ts`                  | `Sandbox` and `SandboxProvider` interfaces             |
| `sandbox/test/sandbox-without-daemon.test.ts` | Fast tests (no pidnap) - PASS                          |
| `sandbox/test/daemon-in-sandbox.test.ts`      | Full integration tests - FAIL                          |
| `packages/pidnap/src/cli.ts`                  | Pidnap CLI with RPCHandler                             |
| `packages/pidnap/src/api/server.ts`           | Pidnap oRPC router                                     |
