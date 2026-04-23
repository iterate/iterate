# agents e2e test infrastructure

## Architecture

Two layers:

1. **`test.extend` base** (`e2e` fixture) — thin vitest-specific shell: artifact dirs, lifecycle hooks, injected config. Auto-provided to every test.
2. **Async disposable factories** — the real work. `createMockInternet`, `createLocalDevServer`, `createEphemeralWorker`, etc. Composed imperatively in test bodies via `await using`. Also usable outside tests (scripts, REPL, CI).

## Fixture layer cake

```
Layer 0: vitest.config.ts
  - Creates runRoot (temp dir via mkdtempSync)
  - Reads env: EVENTS_BASE_URL, ALCHEMY_STAGE, etc.
  - provide: { runRoot, eventsBaseUrl, ... }
  - onConsoleLog: captures to per-test artifact files

Layer 1: test.extend base fixture (auto-injected as `e2e`)
  - artifactDir, outputLogPath, resultPath (per-test temp dir)
  - executionSuffix (unique slug for isolation)
  - testSlug, fileSlug, fullName, testId
  - onTestFailed/onTestFinished hooks write result.json + footer
  - events.append(path, event), events.waitForEvent(path, predicate, opts?)
  - events.client (raw oRPC client, escape hatch)

Layer 2+: async disposable factories (composed in test body via `await using`)

  createMockInternet({ ... })
    - useMockHttpServer (MSW)
    - Always records traffic; HAR asserted via toMatchFileSnapshot at test end
    - MCP stub handlers
    - Returns: { url, getHar(), use(), ... } & AsyncDisposable

  createLocalDevServer({ egressProxy?, eventsBaseUrl, ... })
    - Spins up alchemy.run.ts locally (ALCHEMY_LOCAL=true)
    - Acquires Semaphore tunnel + cloudflared so remote events can reach it
    - Returns: { publicUrl, callbackUrl, ... } & AsyncDisposable

  createEphemeralWorker({ egressProxy?, eventsBaseUrl, stage, ... })
    - Deploys a temporary CF worker via alchemy.run.ts (ALCHEMY_LOCAL=false)
    - Acquires Semaphore tunnel so deployed worker can reach local mock proxy
    - Returns: { publicUrl, callbackUrl, ... } & AsyncDisposable

  (deployed-live-worker tests use no server fixture — just e2e.events against AGENTS_BASE_URL)
```

### Dependency order

Factories are composed imperatively, so ordering is explicit in the test body:

```ts
// mockInternet BEFORE server (server needs proxy URL at startup)
await using mock = await createMockInternet({ ... });
await using server = await createLocalDevServer({ egressProxy: mock.url, ... });
```

For deployed-live-worker tests, no server fixture — just `e2e.events` directly.

### Mutual exclusivity

- `createLocalDevServer`, `createEphemeralWorker`, deployed-live-worker are mutually exclusive per test
- `createMockInternet` is incompatible with deployed-live-worker (can't control egress)

## File organization

```
apps/agents/e2e/
  test-support/           # vitest-specific + agents-specific helpers
    e2e-test.ts           # test.extend base, the only vitest-coupled file
    vitest-artifacts.ts   # artifact paths, console capture
    create-local-dev-server.ts
    create-ephemeral-worker.ts
    create-mock-internet.ts
    events-stream.ts      # append, waitForEvent (SSE-based)
  vitest/                 # test files
    __snapshots__/        # HAR files (vitest snapshot convention)
  vitest.config.ts

packages/shared/src/test-support/  # generic, reusable across apps
  (useCloudflareTunnelLease, useCloudflareTunnel, useDevServer, useMockHttpServer — already here)
```

All async disposable factories in `test-support/` are importable from scripts, REPL, CI — no vitest dependency.

## Tags

Tags describe test properties, used for CLI filtering (`--tags-filter`).

| Tag                                             | Meaning                                                            |
| ----------------------------------------------- | ------------------------------------------------------------------ |
| `local-dev-server`                              | Spins up a local agents dev server for the test                    |
| `deployed-ephemeral-worker-with-egress-capture` | Deploys a temporary CF worker with controlled egress               |
| `deployed-live-worker`                          | Runs against an existing shared deployment (staging/prod)          |
| `mocked-internet`                               | Uses HAR replay / mock proxy, no real upstream calls               |
| `live-internet`                                 | Hits real external services (LLMs, MCP servers, etc.)              |
| `slow`                                          | Materially slower than inner loop (real LLM calls, even if cached) |

### Tag constraints

- Exactly one of `local-dev-server`, `deployed-ephemeral-worker-with-egress-capture`, `deployed-live-worker` per test
- `mocked-internet` requires `local-dev-server` or `deployed-ephemeral-worker-with-egress-capture`
- `deployed-live-worker` implies `live-internet`

## HAR fixtures

HAR files are **test inputs** (replay sources), not test outputs. They use an explicit
record/replay mode, not vitest snapshot assertions.

- HAR files live in `__snapshots__/` next to test files (vitest naming convention, git-committed)
- `createMockInternet` encapsulates the record/replay decision:
  ```ts
  await using mock = await createMockInternet({
    harPath: "./__snapshots__/codemode-builtin.har",
  });
  // If HAR exists and E2E_RECORD_HAR != "1" → replay (onUnhandledRequest: "error")
  // If HAR missing or E2E_RECORD_HAR == "1"  → record + normalize + write
  ```
- **Normalization at write time**: zero timings, strip volatile headers (`cf-ray`, `date`, `age`,
  `alt-svc`, `nel`, `report-to`), sort headers alphabetically. This makes re-recorded HARs
  produce meaningful git diffs.
- **Hostname rewriting at replay time**: `prepareAgentsHarForReplay` rewrites run-specific
  project hostnames so MSW matchers work with the current run slug.
- One record script: `pnpm test:e2e:record` (replaces the 3 separate record scripts)

## Event waiting model

Tests interact with the events system via `e2e.events`:

- **`append(path, event)`** — pushes an event to a stream via oRPC
- **`waitForEvent(path, predicate, opts?)`** — opens a fresh SSE connection (oRPC `eventIterator` on `GET /streams/{path}` without `beforeOffset`), resolves when an event matching the predicate arrives. Each call is self-contained: opens connection, scans, resolves, closes.

This replaces the current polling model (re-fetching full history every 500ms).

## Artifact structure

Each test run creates a temp root. Per-test artifacts:

```
<runRoot>/
  <file-slug>/
    <test-slug>/
      vitest-output.log    # timestamped console capture
      result.json          # structured pass/fail + errors
```

Console output captured via `onConsoleLog` in vitest.config.ts. Results written by `onTestFailed`/`onTestFinished` hooks in the base fixture.

## Concurrency

- Each test gets its own tunnel, server, and mock proxy — fully independent, no shared mutable state
- Cross-file parallelism: enabled (`fileParallelism: true`)
- Within a file: no `describe.sequential` needed since tests don't share infrastructure
- Each test gets a unique `executionSuffix` so stream paths never collide
- Future optimization: share tunnel/server across tests in the same file if resource pressure becomes a problem

## Tunnels

Two independent tunnel needs, mutually exclusive in practice:

1. **Events → local agents** — remote events service delivers webhooks/websockets to local dev server. Needed only for `local-dev-server`.
2. **Deployed agents → local mock proxy** — ephemeral worker routes egress through local MSW server. Needed only for `deployed-ephemeral-worker-with-egress-capture`.

Both use Semaphore tunnel lease + cloudflared. Never need both simultaneously.

## Example test shape

```ts
import { test } from "../test-support/e2e-test.ts";
import { createMockInternet } from "../test-support/create-mock-internet.ts";
import { createLocalDevServer } from "../test-support/create-local-dev-server.ts";

test(
  "codemode runs builtin + OpenAPI + fetch",
  { tags: ["local-dev-server", "mocked-internet"] },
  async ({ e2e }) => {
    await using mock = await createMockInternet();
    await using server = await createLocalDevServer({
      egressProxy: mock.url,
      eventsBaseUrl: e2e.eventsBaseUrl,
      eventsProjectSlug: e2e.runSlug,
    });

    await e2e.events.append(server.streamPath, {
      type: "https://events.iterate.com/events/stream/subscription/configured",
      payload: {
        slug: `sub-${e2e.executionSuffix}`,
        type: "websocket",
        callbackUrl: server.callbackUrl,
      },
    });

    await e2e.events.append(server.streamPath, {
      type: "codemode-block-added",
      payload: { script: CODEMODE_SCRIPT },
    });

    const result = await e2e.events.waitForEvent(
      server.streamPath,
      (e) => e.type === "codemode-result-added",
    );

    expect(result.payload.answer).toBe(42);
  },
);
```
