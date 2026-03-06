# Daemon Package - Refactoring Concerns & Proposals

## Executive Summary

The daemon package has **accumulated complexity** from organic growth. The core issues are:

1. **Scattered event handling** - Three+ files independently interpret the same event types
2. **Over-engineering for single use case** - Factory patterns, dual hooks, complex abstractions with only one implementation
3. **Inconsistent patterns** - Effect vs Promise mixing, manual pub/sub vs Effect.PubSub, mutable state in Effect code
4. **Type safety gaps** - Unsafe `as` casts scattered throughout, events lack proper schema validation

---

## Top 10 Refactoring Opportunities (Ranked by Impact)

### HIGH IMPACT

#### 1. Consolidate Event Type Handling

**Files affected**: 5+

**Problem**: `messages-reducer.ts`, `persistent-stream-reducer.ts`, and `adapter.ts` all independently check event types with hardcoded strings.

**Current state**:

- `messages-reducer.ts:121-225` - checks `"agent_end"`, `"message_start"`, etc.
- `persistent-stream-reducer.ts:396-406` - checks same types for streaming state
- `types.ts:29-42` - defines `PiEventTypes` but they're not used by the UI

**Proposal**: Create a single event router/dispatcher that all consumers use:

```typescript
// event-router.ts
export const routePiEvent = <T>(event: PiEvent, handlers: {
  onAgentEnd?: () => T,
  onMessageStart?: (msg: MessageStartEvent) => T,
  // ...
}): T | undefined => { ... }
```

---

#### 2. Simplify StreamManager.subscribeAll()

**Location**: `stream-manager.ts:117-199`

**Problem**: 83 lines of complex polling-based discovery with multiple interlocking concerns.

**Issues**:

- Hardcoded 1-second polling interval
- Dual offset semantics (existing streams from END, new from START)
- Fire-and-forget fiber forwarding
- Manual HashSet tracking alongside per-stream subscriptions

**Proposal**:

- Replace polling with event-driven discovery (emit stream creation events)
- Extract discovery logic into separate function
- Use Effect's resource management instead of manual finalizers

---

#### 3. Merge the Two UI Stream Hooks

**Problem**: `useStreamReducer` (app.tsx:131-177) and `usePersistentStream` (persistent-stream-reducer.ts) do similar things with different complexity levels.

**Current state**:

- `useStreamReducer`: Simple SSE + offset tracking (~47 lines)
- `usePersistentStream`: Complex with localStorage, BroadcastChannel, batched replay (~400 lines)

**Proposal**: Create one parameterized hook:

```typescript
usePersistentStream(url, reducer, {
  persist: boolean,
  crossTab: boolean,
  batchReplay: boolean,
});
```

---

#### 4. Fix Unsafe Type Assertions

**Files affected**: multiple

**Problem**: `as unknown as EventStreamId`, `data.payload as SessionCreatePayload` scattered throughout.

**Locations**:

- `adapter.ts:188, 206, 218` - inline casts without validation
- `stream.ts:73`, `index.ts:115` - EventStreamId coercion
- `messages-reducer.ts:160-168, 185-193` - content block extraction

**Proposal**: Use Schema validation at boundaries, not runtime casts. Create properly typed extractors:

```typescript
const extractSessionPayload = Schema.decodeUnknown(SessionCreatePayload);
```

---

### MEDIUM IMPACT

#### 5. Remove EventStreamFactory Abstraction

**Location**: `stream-factory.ts`

**Problem**: Full factory pattern with only ONE implementation (`Plain`). `ActiveFactory = PlainFactory`. The `Default` implementation just throws an error.

**Proposal**: Delete `stream-factory.ts`, have StreamManager call `makeEventStream()` directly.

---

#### 6. Unify Pi Adapter Event Pipelines

**Location**: `adapter.ts:55-247`

**Problem**: Two separate event flows that must coordinate:

- `piEventQueue` for Pi session events (lines 72-85)
- `processFiber` for action events (lines 202-228)

Plus mutable `PiAdapterState` with null checks everywhere.

**Proposal**:

- Merge into single stream pipeline
- Replace mutable state with Effect.Ref
- Use Effect's error handling instead of fire-and-forget `Effect.runFork`

---

#### 7. DRY Up Event Envelope Creation

**Location**: `types.ts:77-113, 147-209`

**Problem**: Four event classes repeat identical envelope structure. Factory functions don't use the generic `makeIterateEvent()` helper.

**Proposal**: Either:

- (a) Make specific factories call `makeIterateEvent()`
- (b) Use a generic event class parameterized by payload type

---

#### 8. Replace Manual Registry Pub/Sub

**Location**: `index.ts:87-102`

**Problem**: Hand-rolled `Set<RegistrySubscriber>` with manual iteration and error-based deletion.

**Proposal**: Use Effect.PubSub which is already in the codebase.

---

### LOWER IMPACT (Quick Wins)

#### 9. Centralize String Constants

**Problem**: Same strings defined multiple times:

- `PI_EVENT_RECEIVED` in `messages-reducer.ts:46` AND `app.tsx:12`
- Event type strings hardcoded vs. using `PiEventTypes` constant

**Proposal**: Create `constants.ts`, import everywhere.

---

#### 10. Delete Redundant runScopedEffect

**Location**: `index.ts:60-66`

**Problem**: Two identical effect runners:

```typescript
const runEffect = <A, E>(effect) => runtime.runPromise(Effect.scoped(effect));
const runScopedEffect = <A, E>(effect) => runtime.runPromise(Effect.scoped(effect));
```

**Proposal**: Keep one, delete the other.

---

## Architectural Observations

### Single-Agent Architecture

The codebase is structured for **one agent type (Pi)** but has abstractions (adapters, factories) suggesting multi-agent design. This creates premature complexity.

**Recommendation**: Either:

- (a) Remove abstractions and keep it simple for Pi-only
- (b) Commit to multi-agent and properly generify (`startAgentSession<T extends AgentType>`)

### Effect vs Promise Mixing

Inconsistent patterns throughout:

- `startPiSession` uses `async/await` wrapping Effect operations
- POST handlers use `Effect.gen()` directly
- Some places use `Effect.runPromise`, others use `Effect.runFork`

**Recommendation**: Pick one approach. Suggest: Effect-first everywhere, only convert to Promise at HTTP boundaries.

### Missing Tests

No tests for:

- `adapter.ts` - critical reattachment logic untested
- `types.ts` - schema validation untested
- Most of `index.ts` - HTTP handlers untested

---

## Proposed Refactoring Order

If tackling this incrementally:

### Phase 1: Quick wins (1-2 hours)

- Delete `runScopedEffect`
- Centralize constants
- Remove unused `AgentActionTypes`

### Phase 2: Type safety pass (half day)

- Add Schema validation at event boundaries
- Create typed extractors to replace `as` casts

### Phase 3: Consolidate hooks (half day)

- Parameterize `usePersistentStream` to handle both use cases
- Remove `useStreamReducer`

### Phase 4: Simplify streaming (1 day)

- Refactor `subscribeAll()`
- Unify adapter event pipelines
- Remove factory abstraction

### Phase 5: Architecture decision (depends on roadmap)

- Commit to single-agent or multi-agent
- Adjust abstractions accordingly

---

## Detailed Issue Locations

### Duplicated Code

| Issue                        | Location 1                             | Location 2                                               | Notes                            |
| ---------------------------- | -------------------------------------- | -------------------------------------------------------- | -------------------------------- |
| `PI_EVENT_RECEIVED` constant | `messages-reducer.ts:46`               | `app.tsx:12`                                             | Identical string                 |
| Offset validation            | `stream.ts:93-104`                     | `stream.ts:141-152`                                      | Copy-pasted validation block     |
| Content block extraction     | `messages-reducer.ts:160-168`          | `messages-reducer.ts:185-193`                            | Similar mapping logic            |
| Registry broadcast           | `index.ts:195-207`                     | `index.ts:236-245`                                       | Nearly identical event structure |
| Offset persistence pattern   | `persistent-stream-reducer.ts:302-306` | `persistent-stream-reducer.ts:336-341, 355-359, 372-377` | Repeated 4+ times                |

### Unsafe Type Casts

| File                  | Line(s)  | Cast                                   | Risk                     |
| --------------------- | -------- | -------------------------------------- | ------------------------ |
| `adapter.ts`          | 77       | `piEvent.type` assumes field exists    | Runtime error if missing |
| `adapter.ts`          | 188, 206 | `event.data as { type?: string }`      | No validation            |
| `adapter.ts`          | 195, 218 | `data.payload as SessionCreatePayload` | Assumes structure        |
| `stream.ts`           | 73       | `as unknown as EventStreamId`          | Type coercion            |
| `index.ts`            | 115      | EventStreamId coercion                 | Type coercion            |
| `messages-reducer.ts` | 160-168  | `c as Record<string, unknown>`         | Multiple casts           |

### Complexity Hotspots

| Location                               | Lines | Issue                                                      |
| -------------------------------------- | ----- | ---------------------------------------------------------- |
| `stream-manager.ts:117-199`            | 83    | subscribeAll() - polling, fibers, offset logic intertwined |
| `adapter.ts:55-247`                    | 193   | Dual event pipelines, mutable state, reattachment          |
| `index.ts:111-220`                     | 110   | startPiSession - nested async, deferred, fiber management  |
| `persistent-stream-reducer.ts:195-226` | 32    | Batched replay with scheduler detection                    |
| `messages-reducer.ts:108-242`          | 135   | Deeply nested conditionals, repeated patterns              |

---

## Questions to Answer Before Refactoring

1. **Multi-agent future?** - Should we keep abstractions for multiple agent types or simplify for Pi-only?

2. **Streaming requirements** - Is the polling-based stream discovery necessary, or can we use event-driven discovery?

3. **Persistence requirements** - Does the registry need the full `usePersistentStream` capabilities (cross-tab, localStorage)?

4. **Test coverage goals** - What's the acceptable level of test coverage for adapter and HTTP handlers?

5. **Effect adoption level** - Should we go all-in on Effect or maintain Promise interop at more boundaries?
