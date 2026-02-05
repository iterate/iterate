---
state: in_progress
priority: high
size: medium
---

# Daytona Provider Integration Testing

Validate that sandbox integration tests work against Daytona provider, not just Docker.

## Test Progress (2026-02-05)

### Bugs Fixed

1. **Constructor initialization bug** (`sandbox/providers/types.ts`)
   - Issue: Parent class constructor called `this.envSchema.parse()` but `envSchema` is a field declaration that initializes AFTER `super()` returns
   - Fix: Removed `parseEnv` call from parent constructor; each subclass now calls `this.parseEnv(rawEnv)` after `super()`

2. **Sandbox name collisions** (`sandbox/providers/daytona/provider.ts`)
   - Issue: Concurrent tests tried to create sandboxes with same name
   - Fix: Added random 6-char suffix to sandbox names: `${machineSlug}-${randomSuffix}`

3. **Shell argument quoting** (`sandbox/providers/daytona/provider.ts`)
   - Issue: Daytona SDK takes command as string, not array; shell special chars broke piping
   - Fix: Added quoting in `exec()` that wraps args containing special chars in single quotes

### Test Results

**Minimal Container Tests (7 tests) - ALL PASS**

```bash
doppler run --config dev -- env RUN_SANDBOX_TESTS=true SANDBOX_TEST_PROVIDER=daytona \
  SANDBOX_TEST_SNAPSHOT_ID=iterate-sandbox-f3cdc8d42015edec580b96bcb7f3a55d48b4ecc6 \
  pnpm sandbox test --run -t "Minimal Container Tests"
```

- container setup correct
- git operations work
- shell sources ~/.iterate/.env automatically
- DUMMY_ENV_VAR from skeleton .env is present
- repo is a valid git repository
- can read git branch
- can read git commit

**Daemon Integration Tests - FAILING**

Tests timeout waiting for `waitForServiceHealthy(sandbox, "daemon-backend")`.

### Root Cause Analysis

The `waitForServiceHealthy` function uses `pidnapClient()` which calls oRPC endpoints via Daytona proxy.

**What works:**

- Daemon health endpoint: `https://3000-{id}.proxy.daytona.works/api/health` returns `200 OK`
- Local daemon health: `curl localhost:3000/api/health` returns `{"status":"ok"}`
- Daytona proxy works correctly for HTTP endpoints

**What doesn't work:**

- Pidnap oRPC endpoint: `https://9876-{id}.proxy.daytona.works/rpc/manager.status` returns `404 Not Found`
- Local pidnap also returns 404: `curl -X POST localhost:9876/rpc/manager.status -H 'Content-Type: application/json' -d '{}'`

**Key insight:** The issue is NOT with Daytona's proxy. Port 9876 is listening, pidnap process is running, but the oRPC endpoint paths don't match. The `RPCHandler` in `packages/pidnap/src/cli.ts` is mounted with `prefix: "/rpc"` but requests to `/rpc/manager.status` return 404.

### Next Steps

1. **Debug oRPC routing** - Investigate why `/rpc/manager.status` returns 404:
   - Check oRPC version in the snapshot vs current code
   - Test locally with Docker to see if same issue exists
   - Add debug logging to pidnap RPCHandler to see what paths it receives

2. **Alternative approach** - Since daemon works, could modify tests to:
   - Skip `waitForServiceHealthy` for daemon tests
   - Use daemon health check instead of pidnap health
   - Test tRPC endpoints directly without pidnap client

3. **Snapshot rebuild** - If oRPC version mismatch:
   - Rebuild snapshot with current code: `doppler run -- pnpm sandbox daytona:push`
   - Re-test with new snapshot

## Commands Reference

```bash
# Run minimal tests (pass)
doppler run --config dev -- env RUN_SANDBOX_TESTS=true SANDBOX_TEST_PROVIDER=daytona \
  SANDBOX_TEST_SNAPSHOT_ID=iterate-sandbox-f3cdc8d42015edec580b96bcb7f3a55d48b4ecc6 \
  pnpm sandbox test --run -t "Minimal Container Tests"

# Run daemon tests (fail - for debugging)
doppler run --config dev -- env RUN_SANDBOX_TESTS=true SANDBOX_TEST_PROVIDER=daytona \
  SANDBOX_TEST_SNAPSHOT_ID=iterate-sandbox-f3cdc8d42015edec580b96bcb7f3a55d48b4ecc6 \
  KEEP_SANDBOX_CONTAINER=true \
  pnpm sandbox test --run -t "daemon accessible"

# List existing snapshots
doppler run --config dev -- pnpm sandbox daytona:list-snapshots
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
