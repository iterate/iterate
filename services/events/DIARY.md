# Development Diary

Append-only log of significant changes and decisions.

---

## 2026-01-21 ~17:30

### Added typed EventSchema system

**Problem:** Event handling used untyped payloads with runtime checks:

```typescript
if (event.type === "iterate:agent:action:send-user-message:called") {
  const content = event.payload["content"];
  if (typeof content === "string") { ... }
}
```

**Solution:** Created `EventSchema` factory in `events.ts` that provides:

- `make(payload)` - typed event creation
- `is(event)` - type guard with discriminant for proper narrowing
- `decodeOption(event)` - Option-based parsing
- `decode(event)` - Effect-based parsing with ParseError

**Key insight:** The type guard must include the `type` discriminant, not just payload shape:

```typescript
// Wrong - causes TypeScript to narrow to `never` after multiple checks
event is EventInput & { payload: P }

// Correct - only excludes events with this specific type
event is E & { type: Type; payload: P }
```

Also made the guard generic (`<E extends EventInput | Event>`) to preserve `Event` properties when narrowing.

Refactored `openai-simple.ts` to use EventSchema for all event handling - much cleaner.

---

### Typed history array with Prompt.Message

Changed `history: Schema.Array(Schema.Any)` to `Schema.Array(Schema.encodedSchema(Prompt.Message))`.

Using `encodedSchema()` because we build plain `{ role, content }` objects (the encoded format), not full `Message` instances with branded type IDs. The `MessageEncoded` type accepts string content directly.

---

### Simplified shouldTriggerLlmResponse

Replaced nested `Option.match` with early returns:

```typescript
// Before
return Option.match(this.llmRequestRequiredFrom, {
  onNone: () => false,
  onSome: (requiredFrom) =>
    Option.match(this.llmLastRespondedAt, {
      onNone: () => true,
      onSome: (respondedAt) => Offset.gt(requiredFrom, respondedAt),
    }),
});

// After
if (Option.isNone(this.llmRequestRequiredFrom)) return false;
if (Option.isNone(this.llmLastRespondedAt)) return true;
return Offset.gt(this.llmRequestRequiredFrom.value, this.llmLastRespondedAt.value);
```

---

## 2026-01-21 ~17:15

### Added type narrowing and consumption tracking to TestSimpleStream

**Problem:** `waitForEvent(RequestStartedEvent)` was returning `TypedEvent<{ readonly [x: string]: unknown }>` instead of a properly typed event. Also, calling `waitForEvent` twice returned the same event, making sequence testing awkward.

**Solution:**

1. **Type narrowing** - Updated local `EventSchema` interface to match actual structure with `<Type extends string, P>`. Added `PayloadOf<S>` and `TypeOf<S>` helper types. Now `waitForEvent(RequestStartedEvent)` returns `Event & { type: "iterate:openai:request-started"; payload: {} }`.

2. **Consumption tracking** - Each event type has its own consumption counter. `waitForEvent` returns the next unconsumed event of that type. Independent per-type tracking means waiting for Pings doesn't affect waiting for Pongs.

3. **Default timeout** - 300ms default with optional override prevents tests hanging forever.

Added `TestSimpleStream.test.ts` documenting the consumption API.

---

## 2026-01-21 ~17:00

### Extracted test utilities to src/testing/ folder

Created dedicated folder with:

- **TestLanguageModel** - Context.Tag providing both test control (`emit`, `complete`, `fail`, `waitForCall`) AND `LanguageModel.LanguageModel`. Uses `Layer.scopedContext` to share same instance under both tags.

- **TestSimpleStream** - Mock `SimpleStream` extending the interface with test methods (`appendEvent`, `getEvents`, `waitForSubscribe`, `waitForEvent`, `waitForEventCount`).

---

## 2026-01-21 ~16:45

### Adopted linear wait-and-assert pattern in tests

**Problem:** Tests collecting all events at end and asserting out of order were hard to follow.

**Solution:** Wait for each event as it should arrive, assert immediately:

```typescript
// Before (hard to follow)
const events = yield * stream.getEvents();
const request = events.find((e) => RequestStartedEvent.is(e));

// After (linear, clear)
const request = yield * stream.waitForEvent(RequestStartedEvent);
yield * lm.emit(Response.textDeltaPart({ id: "msg1", delta: "Hi!" }));
const sse = yield * stream.waitForEvent(ResponseSseEvent);
expect(sse.payload.requestOffset).toBe(request.offset);
```

Also switched to `Response.textDeltaPart()` for type-safe stream part construction.

---

## 2026-01-21 16:15

### Fixed LLM re-triggering loop

**Problem:** Consumer was triggering LLM requests in a loop. After a request completed, it would immediately start another one.

**Root cause:** The trigger condition used `shouldSendLlmRequest: boolean` which stayed true until we processed our own `request-started` event. But older events (like `request-cancelled` from a previous request) would arrive first due to offset ordering, and the boolean was still true.

**Solution:** Replace boolean with offset comparison:

- `llmRequestRequiredFrom: Option<Offset>` - offset of user message needing response
- `llmLastRespondedAt: Option<Offset>` - offset of last request-started (never cleared)
- Trigger when `requiredFrom > lastRespondedAt`

This naturally prevents re-triggering because `request-started` always has a higher offset than the user message that triggered it.

**Key insight:** Don't clear `llmLastRespondedAt` on request-ended/cancelled. It represents "what we've responded to", not "what's currently in flight". In-flight tracking uses local `currentFiber` variable instead.

Added `Offset.gt/gte/lt/lte` comparison utilities to domain.

---

## 2026-01-21 ~15:45

### Switched stream storage from NDJSON to YAML

Changed FileSystem storage format from newline-delimited JSON to YAML documents separated by `---`. More human-readable for debugging sessions.

---

## 2026-01-21 ~15:30

### Added consumer-based architecture

Introduced `SimpleConsumer` abstraction for path-scoped consumers. Each consumer's `run` is called once per path with a `SimpleStream` interface for reading/writing events.

Created `OpenAiSimpleConsumer` that:

- Hydrates conversation history from events
- Triggers OpenAI generation on user messages
- Streams responses back as events
- Supports fiber interruption for cancelling in-flight requests
