# Design Review: Sharp Edges

This note records critique of the current sketches in this folder and the
shared `packages/shared/src/stream-processors` primitives. Treat these as
design blockers or things to explicitly accept before turning sketches into
stable APIs.

## Highest-Risk Issues

### 1. We currently have two event envelopes

`packages/shared/src/stream-processors/types.ts` defines a generic
`StreamEventInput` / `StreamEvent` envelope. The real stream service uses
`@iterate-com/events-contract` `EventInput` / `Event`.

That means expect-type tests can pass for processor events that the actual
stream append path rejects. This violates the `jonasland/RULES.md` point that
API schemas and contracts are high-care architecture.

Direction:

- Do not stabilize a second envelope casually.
- Either make stream processors depend directly on the canonical events
  contract envelope, or name the local type something explicit like
  `ProcessorTypedEventView`.
- Runtime `streamApi.append` should parse/validate the event against the
  resolved emitted event definition before forwarding to the actual stream.

### 2. `consumes` / `emits` typo safety is still too runtime-dependent

The type machinery can infer consumed/emitted unions from string keys, but the
current `defineProcessorContract` does not yet force unresolved strings to fail
at the contract definition site. `validateProcessorContract` catches this only
if every host calls it.

Direction:

- Add compile-time tests that typos in `consumes` and `emits` fail exactly at
  `defineProcessorContract(...)`.
- Keep runtime validation for dynamically loaded processors.
- Do not rely on hook-site `never` types as the failure mode; the author should
  see the error where they declared the bad string.

Status:

- Implemented in the shared primitive with expect-type coverage.

### 3. Saving reduced state before `afterAppend` can lose derived appends

Several sketches reduce and save state, then run `afterAppend`. If
`afterAppend` fails after state is saved, the host may never retry the derived
append for that source event.

This is the central consistency problem. It cannot be papered over by saying
derived appends have idempotency keys.

Direction:

- Be explicit that hosts provide at-least-once `afterAppend` unless they can
  commit state/checkpoint/derived appends atomically.
- Persist `{ state, reducedThroughOffset, afterAppendCompletedThroughOffset? }`
  or an equivalent host-specific delivery marker if retries are needed.
- For Durable Object hosts that append to the same SQLite-backed stream, prefer
  one transaction where possible.
- For remote/pull hosts, accept at-least-once side effects and require
  idempotency keys for derived appends.

Status:

- The shared primitive now exports a minimal host progress envelope:
  `{ state, reducedThroughOffset, afterAppendCompletedThroughOffset }`.
- Tests show the important failure mode: state can be reduced through an event
  while `afterAppendCompletedThroughOffset` remains behind after a hook failure.

### 4. Pull runner has a read/subscribe race

The prototype reads history up to `"end"` and then subscribes from `"end"`.
An event committed between those two calls can be skipped.

Direction:

- Host storage needs a real `reducedThroughOffset`.
- Catch-up should read after that offset until a known high-water mark.
- Live subscribe should start after the last actually reduced offset, not a new
  independently sampled `"end"`.
- If the stream API cannot expose a race-free handoff, the runner needs a
  conservative overlap and idempotent reduction.

### 5. Push hosts currently call `onStart` too early in the sketch

The websocket DO and mixin sketches call `onStart` before reducing the first
live event. The locked invariant is: restored/replayed state first, then
`onStart`, then live `afterAppend`.

Direction:

- Push host first ensures reduced state is current for the event it is about to
  process.
- Then it calls `onStart` once with that caught-up state.
- Then it runs live `afterAppend` for that event.

Concrete example:

- If the first event is this processor's `processor-registered` event, `onStart`
  should see `hasRegisteredCurrentVersion: true` and not append another
  registration attempt.

### 6. Same-host composition must compute all reductions before saving

The current composition sketch saves each processor slice independently. If one
processor saves and another fails, the host has partial state for the same
source event.

Direction:

- For same-storage hosts, calculate all reductions first.
- Commit all changed slices and reduced offsets together.
- Then run all live `afterAppend` hooks.
- Do not give ordinary processors sibling state access as part of that
  transaction.

### 7. `withStreamProcessor` mixes many-stream API with one-stream storage

The sketch accepts per-event `streamPath` and tracks startup per path, but saves
one unkeyed state value.

Direction:

- First version of the mixin should bind one processor instance to one stream
  path and one state slot.
- A many-stream host is a separate design: state must be keyed by stream path,
  and startup/delivery state must also be keyed by stream path.

### 8. Codemode tool-provider state is not yet serializable enough

The Codemode sketch stores `executeCallable` / `getTypesCallable` as
`z.unknown()` inside stream events and reduced state. That muddies the exact
line we care about: reduced state is serializable, runtime state is live JS
objects/handles.

Direction:

- Stream events should carry serializable tool-provider identity/config, not
  live callable handles.
- `onStart` should materialize live callables or DO/RPC stubs from that reduced
  config.
- If Cloudflare RPC objects are intentionally serializable across a boundary,
  we need first-party docs and a very explicit comment explaining that fence.

### 9. Built-in `beforeAppend` needs a strict sync/async decision

The shared type allows async `beforeAppend`, but the cleaned-up `stream.ts`
sketch calls it in a synchronous-looking path.

Direction:

- If built-in `beforeAppend` may be async, every host path must `await` it
  before commit.
- If it must be synchronous for simplicity and transaction clarity, encode that
  in the type.

### 10. State migration is not modeled

Processor `version` exists, but persisted state has no envelope, no stored
processor version, and no migration hook.

Direction:

- Host persistence should likely store:

```ts
{
  processorSlug: string;
  processorVersion: string;
  reducedThroughOffset: number;
  state: unknown;
}
```

- Add a host-level migration hook before `contract.stateSchema.parse(...)`, or decide
  explicitly that early versions may wipe/rebuild from event history.

## Awkward API Bits

### Contract modules must be frontend-safe

The frontend reducer proof of concept works only because the contract file is
pure: Zod schemas, contract, reducer, projection helper. If a contract module
also imports Workers-only types, `Ai`, `Fetcher`, Cloudflare RPC targets, or DO
classes, the agents UI cannot safely import it.

Direction:

- Use a hard split:
  - `agent-loop.contract.ts`: frontend-safe schemas/reducer/helpers
  - `agent-loop.processor.ts`: backend-only implementation factory

### `StreamApi` is shape-compatible but not contract-safe

The concrete `apps/agents/src/entrypoints/stream-api.ts` takes generic
`EventInput`. Hook typing says only declared `emits` can append, but the runtime
service cannot enforce this itself.

Direction:

- Wrap the concrete entrypoint in a per-processor typed adapter.
- The adapter should validate emitted event inputs against the contract's
  resolved `emits` definitions before forwarding.

### README and contracts disagree about AgentLoop/Codemode coupling

The README example shows AgentLoop depending on Codemode and consuming a
Codemode result event. The concrete contract sketch does not.

Direction:

- Decide whether `codemode-result-added` becomes model-visible by Codemode
  emitting an `agent-input-added` row, or by AgentLoop consuming
  `codemode-result-added` and rendering it.
- My current preference: AgentLoop owns rendering events into model-visible
  context, so AgentLoop should consume the Codemode result event. Codemode
  should not write model-visible prose unless it is explicitly a Codemode-owned
  primer/registration message.

### `tool-provider-config-updated` ownership is unclear

The event is currently sketched as Codemode-owned, but MCP/tool-provider code
also wants to produce it.

Direction:

- If it is a generic tool-provider event, it should be owned by a small
  `ToolProviderProcessorContract` or `CoreToolProviderContract`, not Codemode.
- Codemode should consume it.

### Naming is still not fully aligned

`AGENTS.md` says acronyms are all caps except `Id`; `jonasland/RULES.md` says
not to use all-caps acronyms. Public API names such as `MCPConnection`,
`MCPToolProvider`, and `AgentLoopProcessorDO` need a repo-level decision before
stabilizing.

My current bias:

- Follow local repo-wide `AGENTS.md` for code unless Jonas explicitly overrides
  it for this area.
- Avoid `DO` suffix in public names anyway. Prefer `AgentLoopProcessorDurableObject`
  if the class name matters, or keep the durable object class unexported from
  ordinary contract modules.
