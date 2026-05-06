# Codemode Depth Debug Repro Report

## Scope

Created a minimal Cloudflare Workers/miniflare/Vitest repro under:

`apps/os2/tmp/codemode-depth-debug/repro`

It models this OS2-relevant call chain without importing product code:

`public fetch route -> ctx.exports WorkerEntrypoint -> Durable Object -> ctx.exports WorkerEntrypoint`

Dynamic Workers were not included. The core question is answered by ordinary `ctx.exports` loopback WorkerEntrypoint RPC plus Durable Object RPC, and adding a loader would make the repro larger without changing the first-order depth question.

## Run Command

From the repository root:

```bash
pnpm --dir packages/shared exec vitest run --config ../../apps/os2/tmp/codemode-depth-debug/repro/vitest.config.ts
```

This follows the existing OS2 Durable Object test pattern: run Vitest from `packages/shared`, where the Cloudflare Vitest pool dependency is installed.

Running through `apps/os2` loaded mismatched Vitest internals in this workspace and failed before tests ran with:

`TypeError: Cannot destructure property 'limit' of 'this.config.experimental.importDurations' as it is undefined.`

## Files

- `README.md`: one-command usage and case descriptions.
- `vitest.config.ts`: Cloudflare Vitest pool config rooted through `packages/shared`.
- `wrangler.vitest.jsonc`: one Durable Object binding, `RECURSOR`.
- `entry.workerd.vitest.ts`: public worker route, `RecurserEntrypoint`, and `RecursorDurableObject`.
- `codemode-depth-debug.workerd.test.ts`: shallow, bounded, and stress tests.

## Observed Results

Command:

```bash
pnpm --dir packages/shared exec vitest run --config ../../apps/os2/tmp/codemode-depth-debug/repro/vitest.config.ts
```

Result:

```text
Test Files  1 passed (1)
Tests       3 passed (3)
Duration    566ms
```

The Cloudflare pool also printed this teardown line while still exiting successfully:

```text
exception = workerd/api/web-socket.c++:821: disconnected: WebSocket peer disconnected
```

## Case Details

### Shallow

Route: `/shallow`

Call chain:

`fetch -> ctx.exports.RecurserEntrypoint.shallow -> RECURSOR.shallow -> this.ctx.exports.RecurserEntrypoint.leaf`

Observed response:

- Status: `200`
- Response header: `x-repro-result: ok`
- Request header preservation: `x-repro-case: shallow` was visible in the JSON body.
- Hop count: `4`

Observed hops:

```json
[
  { "index": 0, "kind": "route", "source": "fetch", "remaining": 0 },
  { "index": 1, "kind": "entrypoint", "source": "route-shallow", "remaining": 0 },
  { "index": 2, "kind": "durable-object", "source": "do-shallow", "remaining": 0 },
  { "index": 3, "kind": "leaf", "source": "do-shallow", "remaining": 0 }
]
```

Conclusion: a public route can call a loopback `WorkerEntrypoint` through `ctx.exports`; a Durable Object can then call another loopback `WorkerEntrypoint` through `this.ctx.exports`.

### Bounded Recursion

Route: `/recurse?remaining=2`

Call chain:

`fetch -> entrypoint -> DO -> entrypoint -> DO -> entrypoint -> DO`

Observed response:

- Status: `200`
- Response header: `x-repro-result: ok`
- Hop count: `7`
- No thrown platform error.

Conclusion: the `route -> entrypoint -> DO -> entrypoint` pattern can recurse at least a few turns in local workerd/miniflare.

### Stress Recursion

Route: `/recurse?remaining=128`

Call chain:

`fetch -> entrypoint -> DO`, then 128 additional `DO -> entrypoint -> DO` bounces until `remaining` reaches zero.

Observed response:

- Status: `200`
- Response header: `x-repro-result: ok`
- Hop count: `259`
- No thrown platform error.
- No observed `Subrequest depth`, recursive-loop, or cross-request I/O error.

Expected hop formula for a successful run:

`1 route hop + 1 initial entrypoint hop + (remaining + 1) DO hops + remaining recursive entrypoint hops`

For `remaining=128`: `1 + 1 + 129 + 128 = 259`.

I also briefly tried `remaining=1024`. It did not report a platform limit quickly; the run was manually stopped after roughly 30 seconds because the repro should stay easy to run. That suggests the limiting factor in this local runtime is practical execution time/chain length, not a small subrequest-depth counter.

## Answer To The Depth Question

In this local Cloudflare Workers/miniflare/Vitest runtime:

- `ctx.exports` `WorkerEntrypoint` calls do not appear to consume the same small recursion/subrequest-depth counter that would stop the modeled call chain.
- Durable Object RPC calls also do not appear to consume such a small counter in this pattern.
- A `route -> entrypoint -> DO -> entrypoint` pattern can recurse. It completed 128 recursive bounces and 259 recorded hops without a platform error.

This is an empirical local-workerd result, not a production guarantee. The repro is intentionally small so it can be rerun after Cloudflare runtime upgrades or against a deployed worker if needed.
