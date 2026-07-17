---
status: complete
size: small
---

# Typed agent append

## Status

Complete. Agent handles expose contract-derived typed `append`; generated payloads are interned once by durable event type in one readable `events` namespace; and the type graph keeps each payload individually addressable so docs closures do not pull the global namespace wholesale. Full OS typecheck and unit tests pass.

## Goal

Expose `itx.agents.get(path).append(...)` as the direct event-oriented alternative to one-helper-per-agent-event APIs. Its input must be a discriminated union derived from `AgentProcessorContract.consumes`, so changing the processor contract or an owned payload schema automatically changes the public itx type.

## Assumptions

- This first slice follows the proposed API literally: the type is derived from every event the agent processor consumes, including dependency-owned lifecycle events.
- `append` forwards to the agent's existing stream and returns the committed events in input order.
- Existing helpers such as `message`, `setStatus`, and `addFiles` remain; replacing or removing them is outside this change.
- Runtime authorization is unchanged. Callers can already append arbitrary inputs through `itx.streams.get(agentPath).append(...)`; this change adds a discoverable, statically narrowed door on the agent handle.
- The generator needed only the smallest demonstrated gaps closed: publish the shared event-input envelope once, and normalize Zod's alternate JSON aliases to the existing `JsonValue` declaration. Structural deduplication was not added.

## Checklist

- [x] Add a public contract utility for append-inputs corresponding to a processor's `consumes` list. *Implemented as `ConsumedInput<Contract>` with wildcard support in `processor-contracts.ts`.*
- [x] Add an agent-specific append-input type derived from `AgentProcessorContract`. *`AgentAppendInput` is generated directly from the contract's consumed events.*
- [x] Expose `Agent.append(...events)` and forward inputs to the agent stream. *Implemented on `AgentRpcTarget` and advertised through `__describe()`.*
- [x] Prove valid consumed events compile and invalid event types/payloads fail through the generated public API. *The standalone published-contract test covers a valid status patch plus two `@ts-expect-error` cases.*
- [x] Regenerate the flat itx API, type graph, and published `iterate/sdk` copy. *All three generated artifacts were refreshed with `pnpm --dir apps/os generate:itx-api`.*
- [x] Run focused tests, typecheck, lint, and formatting checks. *OS typecheck, 1,825 unit tests, focused lint, formatting, and generated freshness all pass.*
- [x] Collect generated payload types by durable event type and emit each payload once. *`internEventPayloadTypes` uses `Map<string, Set<string>>`; its regression test proves two domain aliases reuse one declaration.*
- [x] Put generated payload declarations in an `events` namespace with stable names such as `events.AgentConfiguredPayload`. *The flat SDK has one namespace, with each event's JSDoc directly on its payload type.*
- [x] Keep `AgentAppendInput` compact by referencing namespaced payload declarations instead of inline structures. *The union now consists only of `TypedStreamEventInput<type, events.*Payload>` references.*
- [x] Preserve the namespace and its reference edges in the Itx Type Graph and virtual type environment. *Payload graph nodes use dotted identities such as `events.AgentConfiguredPayload`, so a payload slice excludes its namespace siblings.*
- [x] Re-run generated-contract, graph, typecheck, lint, formatting, and unit-test verification. *Generated tests (including standalone package compilation), graph tests, OS typecheck, focused lint/format, and 1,808 unit tests pass.*

## Implementation log

- 2026-07-17: Task specified on a fresh worktree from `origin/main`. No implementation decisions beyond the assumptions above have been committed yet.
- 2026-07-17: Added the red published-contract test. It failed because `Agent` had no `append`, proving the public path under test.
- 2026-07-17: Added `ConsumedInput`, `AgentAppendInput`, and the forwarding RPC method. Initial generation exposed shared private `TypedStreamEventInput` and Zod JSON aliases; the generator now emits the envelope once and maps those aliases to `JsonValue`.
- 2026-07-17: Regenerated all contract artifacts. `pnpm --dir apps/os typecheck`, focused oxlint/oxfmt, and the full OS unit suite (1,825 passed, 1 skipped) are green.
- 2026-07-17: Follow-up review found the generated `AgentAppendInput` adds roughly 500 lines because payload input/output structures are expanded inline. Reopened the task to intern them before this pattern spreads to other domain objects.
- 2026-07-17: Interned payloads by durable event type and emitted mergeable namespace declarations. Split namespace members into dotted graph nodes so future domains share types without making every docs closure load every event payload.
- 2026-07-17: Narrowed public consumed append payloads to the Zod input type rather than `output | input`, removing identical structural branches while leaving processor `EmittedInput` semantics unchanged.
- 2026-07-17: Final generated SDK is about 5 KB smaller than the first inline typed-append version. OS typecheck, focused lint/format, generated/graph tests, standalone SDK compilation, and the full unit suite are green.
- 2026-07-17: Consolidated the flat SDK's repeated mergeable declarations into one `events` namespace and moved each event's JSDoc directly above its payload type. The graph still normalizes those members into independently fetchable namespace records.
