---
state: in_progress
priority: high
size: medium
---

# Daytona Provider Integration Testing

Validate that sandbox integration tests work against Daytona provider, not just Docker.

## Status Update (2026-02-06)

### Status Update (2026-02-06, Post-Merge Cleanup Pass)

1. Provider create API cleaned up:
   - `CreateSandboxOptions.entrypointArguments` is now top-level.
   - Removed provider-specific `providerOptions` shape.
   - Docker/Daytona/Fly providers all consume the same `entrypointArguments`.
2. Daytona stability improved:
   - Daytona create timeout explicitly set to 180s in provider.
   - Daytona-only timeout-heavy tests increased to avoid false negatives from remote startup latency.
3. Review comments closed:
   - Docker Zod v4 default bug fixed (`DOCKER_SYNC_FROM_HOST_REPO` now `optional().transform(...)`).
   - Daemon client helper now supports typed generic return (no untyped `createTRPCClient` usage at callsite).
   - Fly shared-egress test now cleanly skips when `FLY_API_TOKEN` is not present.
4. Dependency boundary docs clarified in `sandbox/README.md`:
   - one-way dependency flow documented explicitly.

### Validation Summary (local, 2026-02-06)

1. Repo checks:
   - `pnpm typecheck` PASS
   - `pnpm lint` PASS
   - `pnpm test` PASS
   - `pnpm spec` PASS
2. Sandbox integration:
   - Docker full suite: PASS (`RUN_SANDBOX_TESTS=true SANDBOX_TEST_PROVIDER=docker pnpm --dir sandbox test`)
   - Daytona full suite: PASS (with fresh snapshot + `SANDBOX_TEST_SNAPSHOT_ID`)
   - Fly shared egress test: SKIPPED locally due missing `FLY_API_TOKEN` in active Doppler config (test now skips by design when token absent).

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

4. **Docker exec false-positive success**
   - Symptom: `execInContainer` returned output but never validated process exit code.
   - Root cause: no follow-up inspect call to read `ExitCode`.
   - Fix: check `GET /exec/{id}/json` and throw on non-zero exit.

5. **Daemon readiness hid terminal failures**
   - Symptom: test retried until timeout even when pidnap reported terminal states (`stopped`, `max-restarts-reached`).
   - Root cause: terminal-state throw was caught by generic retry catch.
   - Fix: terminal state now throws non-retriable error and fails fast.

6. **Docker default image mismatch (local ergonomics)**
   - Symptom: Docker provider/test defaults pointed at `ghcr.io/iterate/sandbox:local` while local builds produce `iterate-sandbox:local`.
   - Root cause: mixed legacy default names across provider/utils/scripts/tests.
   - Fix: unify to `iterate-sandbox:local` for local defaults, keep fallback checks for GHCR tags, and align env precedence (`DOCKER_IMAGE_NAME` first).

7. **Docker host-sync requested but silently disabled**
   - Symptom: `DOCKER_SYNC_FROM_HOST_REPO=true` could still run unsynced if git metadata resolution failed.
   - Root cause: constructor treated missing git info as `undefined` and continued.
   - Fix: fail fast in constructor when sync is explicitly requested but git info cannot be resolved.

8. **Provider/helper duplication cleanup**
   - `getFetch()` moved into `Sandbox` base class (shared implementation).
   - Duplicate test-helper `execInContainer` removed; tests now reuse provider Docker API helper.

### Verified Test Matrix (local)

1. Daytona:
   - `test/sandbox-without-daemon.test.ts` PASS
   - `test/provider-base-image.test.ts` PASS
   - `test/daemon-in-sandbox.test.ts` PASS
2. Docker:
   - `providers/docker/host-sync.test.ts` PASS when image is pinned to local build via `SANDBOX_TEST_SNAPSHOT_ID=iterate-sandbox:local`
   - `test/daemon-in-sandbox.test.ts` PASS with same pin (`SANDBOX_TEST_SNAPSHOT_ID=iterate-sandbox:local`)
   - `test/provider-base-image.test.ts` PASS with same pin (`SANDBOX_TEST_SNAPSHOT_ID=iterate-sandbox:local`)
   - `test/provider-base-image.test.ts` + `providers/docker/host-sync.test.ts` PASS with no `SANDBOX_TEST_SNAPSHOT_ID` override (new default resolution)
   - `test/daemon-in-sandbox.test.ts` PASS with no `SANDBOX_TEST_SNAPSHOT_ID` override (new default resolution)
3. Repo checks:
   - `pnpm typecheck` PASS
   - `pnpm lint` PASS

### Still Not Great / Risk

1. Daytona local dev config currently does not always include `DAYTONA_SNAPSHOT_NAME`.
   - Without explicit `SANDBOX_TEST_SNAPSHOT_ID`, tests fail at provider env parse.
   - CI is fine because workflows set `SANDBOX_TEST_SNAPSHOT_ID`.
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

1. `SANDBOX_TEST_SNAPSHOT_ID` semantics are good and now less required for Docker local runs due aligned defaults/fallbacks.
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
