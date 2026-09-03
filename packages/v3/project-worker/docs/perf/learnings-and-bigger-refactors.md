# Performance — larger learnings, bigger refactors, and capability-dropping options

Companion to `2026-09-03-autoresearch-log.md`. Everything here is OUTSIDE the loop's rules (a
capability drop, a >10 % LOC change, a platform fact worth remembering) — for Jonas to decide.

## Platform facts learned (edge vs workerd)

## Bigger refactors (allowed by capability, too big for the loop)

## Capability-dropping options (faster, but they take something away)

## F-subreq — the per-invocation subrequest cap bounds single-session append bursts (2026-09-03)

Measured on the deployed worker: 100 `itx.append` calls pipelined over ONE capnweb WebSocket abort
with `Too many API requests by single Worker invocation`. Mechanism: the stateless `/api` worker
holds the socket; each client call becomes one Workers-RPC subrequest to the DO, all attributed to
the single stateless invocation that is pumping that socket, so ~1,000 in-flight calls trip the cap
(`limits.subrequests`, default 1,000; Cloudflare docs workers/platform/limits). A batched append (one
call, N events) is ONE subrequest and does not — 100 events batched cost 34.8 ms and one subrequest.

Why it matters and options (all capability-neutral, none small):

- It is the same class as apps/os's 10,000-delivery silent wall (review measure-next #1) but at the
  APPEND door, and it is LOUD (an error), not silent.
- Raising `limits.subrequests` to the 10,000 max buys 10× headroom for one config line, no code —
  worth doing regardless; a client can still exceed it.
- The durable answer is client-side: the SDK/client could coalesce a burst of single appends on one
  session into one multi-event append (the wire already supports N events per append). That is a
  client change, out of this loop's scope, and belongs with the connection-ergonomics work.
- The bench now guards this scenario (fewer in-flight, or a note) so a run completes.

## W3 — zod is in the worker script twice (~600 KiB of 1,225 KiB); removing it is a refactor, not a loop item (2026-09-03)

Verified on the deployed script: zod appears twice — ~303 KiB as main-worker code (the 8 core
schemas in `src/stream/core-processor.ts`, via `src/stream/events.ts` `defineProcessorContract`) and
~303 KiB inside the `processor.js` SDK string (`src/generated/processor-sdk.ts`, injected into facet
isolates). Together ~half the 1,225 KiB upload and the dominant cold-isolate parse cost.

Verified it is SCRIPT-SIZE / COLD-BOOT only, NOT a per-append cost: zod `.parse` on the main worker
runs at exactly (a) `stateSchema.parse({})` — initialState, at construction / version re-reduce;
(b) `payloadSchema.parse(...)` inside `CoreContract.buildEvent`, called only when BUILDING a core
control event (rewrite-rule-configured, subscription-configured) — never for a plain user
`itx.append`; (c) `SubscriptionName.parse` at subscribe. A `bench/ping` append does zero zod. So the
win is the ~490 ms cold start and resident memory, not append latency.

Why it is not a loop no-brainer (both options are real refactors with a tradeoff):

- **The two copies cannot be shared.** The SDK zod lives in a separate V8 isolate (the confined
  facet); the main-worker zod is the parent's. Dedup is impossible without changing the confinement
  model.
- **The SDK copy cannot switch to zod/mini.** Userspace processors author state schemas with full
  zod's CHAINED builders (`z.object({ counts: z.record(...).default({}) })` — the fixtures do), a
  public authoring API. Switching the SDK to mini breaks it. SDK zod stays.
- **The main-worker copy (option a: zod/mini):** −285 KiB (303 → ~18 KiB). But `core-processor.ts`
  is written in chained builders (~22–32 `.optional()/.default()/.regex()/.int().positive()` sites)
  that mini lacks (`z.optional(...)`, `z._default(...)`, `.check(z.regex(...))`) — a wholesale
  rewrite of the most-read declaration in the package, and a SECOND zod dialect in one package. ~30–100
  lines, behaviour-identical. Capability-neutral; the cost is maintainability (two dialects).
- **The main-worker copy (option b: drop zod):** hand-write `initialState()` and the few door checks
  (`subscriptions.ts`, `itx-expression-rewriting.ts` already half-do). ~−40 lines, but retires the
  "built-ins get schemas, same as userspace" symmetry (`events.ts`, `processor.ts`) — a doctrine
  change, the owner's call.

Recommendation: option (a) if the 285 KiB / faster cold start is wanted and a second zod dialect is
acceptable; otherwise leave it. Re-measure the upload after either. NOT done in the loop because it
is neither small nor free of a design choice.
