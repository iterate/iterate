# durable-stream

Effect-native event streaming infrastructure with AI integration.

## Architecture

```
                            HTTP Layer
  +----------------------------------------------------------+
  |  GET  /agents/:path?offset&live  →  SSE stream           |
  |  POST /agents/:path              →  append event         |
  +----------------------------------------------------------+
                                |
                                v
                         StreamManager
  +----------------------------------------------------------+
  |  liveLayer (core)                                        |
  |    - Manages per-path EventStream instances              |
  |    - PubSub for live subscriptions                       |
  +----------------------------------------------------------+
           |                    |                    |
           v                    v                    v
    StreamStorage         LlmLoopProcessor    CodemodeProcessor
  +----------------+    +------------------+  +------------------+
  | fileSystemLayer|    | Triggers LLM on  |  | Evaluates JS     |
  |  .data/streams/|    | user messages,   |  | code blocks from |
  |  *.yaml files  |    | streams responses|  | assistant msgs   |
  +----------------+    +------------------+  +------------------+
  | inMemoryLayer  |           |
  |  (for testing) |           v
  +----------------+    LanguageModel (OpenAI)
                        +------------------+
                        | gpt-4o via       |
                        | @effect/ai       |
                        +------------------+

                          EventStream
  +----------------------------------------------------------+
  |  append()     →  Storage.append() + PubSub.publish()     |
  |  subscribe()  →  Storage.read() + PubSub.stream()        |
  +----------------------------------------------------------+
```

## Layer Composition

```
ServerLive(port)
 └─ StreamManagerLive
     ├─ ProcessorsLive (merged on top)
     │   ├─ LlmLoopProcessorLayer
     │   │   └─ LanguageModel (OpenAI)
     │   │       └─ OpenAiClient.layer
     │   └─ CodemodeProcessorLayer
     └─ StreamManager.liveLayer
         └─ StreamStorage.fileSystemLayer
             └─ NodeContext.layer
```

## Data Flow

### Append (POST)

```
Client POST
    |
    v
appendHandler
    |
    v
StreamManager.append()
    |
    v
Storage.append() + PubSub.publish()
    |
    +---> Processors receive event via subscribe()
          |
          +-- LlmLoopProcessor: user message? → LLM request → emit responses
          +-- CodemodeProcessor: code block? → evaluate → emit results
```

### Subscribe (GET)

```
Client GET
    |
    v
subscribeHandler
    |
    v
StreamManager.subscribe()
    |
    v
EventStream.subscribe()
    |
    +------------------+
    |                  |
    v                  v
Historical         Live (if enabled)
Storage.read()     PubSub.subscribe()
    |                  |
    +--------+---------+
             |
             v
      Deduplicate (Ref)
             |
             v
      Stream.map(Sse.data)
             |
             v
      SSE Response
```

## Domain Types

| Type           | Description                                                            |
| -------------- | ---------------------------------------------------------------------- |
| `StreamPath`   | Branded string, e.g. `"agent/session-123"`                             |
| `Offset`       | Branded string, zero-padded numeric for ordering                       |
| `EventType`    | Branded string, e.g. `"iterate:agent:action:send-user-message:called"` |
| `EventInput`   | `{ type, payload, version? }` - what clients send                      |
| `Event`        | EventInput + `{ offset, createdAt, trace }` - what storage returns     |
| `TraceContext` | `{ traceId, spanId, parentSpanId }` - provenance tracking              |

## Key Event Types

| Event Type                                      | Trigger                                                 |
| ----------------------------------------------- | ------------------------------------------------------- |
| `iterate:agent:config:set`                      | Switch AI model (`payload.model: "openai" \| "grok"`)   |
| `iterate:agent:action:send-user-message:called` | User message, triggers LLM                              |
| `iterate:llm-loop:request-started`              | LLM request initiated                                   |
| `iterate:llm-loop:response:sse`                 | LLM streaming response chunk (text-delta, finish, etc.) |
| `iterate:llm-loop:request-ended`                | LLM request completed successfully                      |
| `iterate:llm-loop:request-cancelled`            | LLM request failed or interrupted                       |
| `iterate:codemode:*`                            | Codemode processor events                               |

## Processor Pattern

Processors are background workers that react to events on a per-path basis:

```typescript
// Define a processor
export const MyProcessor: Processor<LanguageModel> = {
  name: "MyProcessor",
  run: (stream) =>
    Effect.gen(function* () {
      // stream.subscribe() - live events
      // stream.read() - historical events
      // stream.append() - emit new events
    }),
};

// Convert to a Layer (spawns one processor per active path)
export const MyProcessorLayer = toLayer(MyProcessor);
```

## Storage Format

Events stored as YAML documents in `.data/streams/{path}.yaml`:

```yaml
type: "iterate:agent:action:send-user-message:called"
payload:
  content: "Hello"
offset: "0000000000000001"
createdAt: "2026-01-20T12:00:00.000Z"
version: "1"
trace:
  traceId: "abc123"
  spanId: "span-1"
  parentSpanId: null
---
type: "iterate:llm-loop:response:sse"
payload:
  part: "Hi there!"
offset: "0000000000000002"
createdAt: "2026-01-20T12:00:00.100Z"
version: "1"
trace:
  traceId: "abc123"
  spanId: "span-2"
  parentSpanId: "span-1"
```

## Debugging Sessions

Sessions are stored as human-readable YAML in `.data/streams/`. Each path maps to a file.

### Quick Commands

```bash
# View a session's full event log
cat .data/streams/{path}.yaml

# List all sessions
ls .data/streams/*.yaml

# Count events by type in a session
grep "^type:" .data/streams/{path}.yaml | sort | uniq -c

# Extract just the conversation text (user + assistant)
grep -A1 "content:" .data/streams/{path}.yaml   # user messages
grep -A1 "delta:" .data/streams/{path}.yaml     # assistant deltas

# Find sessions with errors
grep -l "request-cancelled" .data/streams/*.yaml

# Watch a session live (while server is running)
tail -f .data/streams/{path}.yaml
```

### Event Lifecycle

A typical request flow in the YAML:

```
request-started (offset N)
  ↓
response:sse (response-metadata)
response:sse (text-start)
response:sse (text-delta) × N
response:sse (text-end)
response:sse (finish)
  ↓
request-ended (offset M)
```

If something goes wrong, you'll see `request-cancelled` instead of `request-ended`.

### Checking History

The `finish` event includes token usage - compare `inputTokens` across requests to verify history is accumulating:

```bash
grep -A5 "type: finish" .data/streams/{path}.yaml | grep inputTokens
```

## Service Patterns

Services follow the Effect Context.Tag pattern:

```typescript
// Definition
export class StreamManager extends Context.Tag("@app/StreamManager")<
  StreamManager,
  {
    readonly subscribe: (input: {...}) => Stream.Stream<Event, Error>;
    readonly append: (input: {...}) => Effect.Effect<void, Error>;
  }
>() {}

// Layer
export const liveLayer = Layer.effect(StreamManager, make);

// Usage
const manager = yield* StreamManager;
yield* manager.append({ path, event });
```

## Event Tracing

Events carry provenance information via `TraceContext`, using Effect's built-in tracing:

```typescript
// TraceContext embedded in every Event
{
  traceId: "abc123",      // Groups all related events in the same trace
  spanId: "span-1",       // Identifies the span that created this event
  parentSpanId: "span-0"  // Links to parent span (null if root)
}
```

### How It Works

1. **HTTP creates root span**: `POST /agents/:path` wraps append in `Effect.withSpan("http.append-event")`
2. **EventStream captures trace**: `append()` reads current span via `Effect.currentSpan`
3. **Processors inherit trace**: Use `withTraceFromEvent(event)` to link work to originating event

```typescript
// In processors - inherit trace context from the triggering event
Stream.runForEach((event) =>
  Effect.gen(function* () {
    // ... process event
  }).pipe(withTraceFromEvent(event)),
);
```

### Span Hierarchy

```
Trace: abc123
├─ http.append-event (root span from HTTP POST)
│   └─ Event: UserMessageEvent { trace: { traceId: abc123, spanId: span-1 } }
├─ llm-loop.request (parent = span-1)
│   └─ Events: RequestStartedEvent, ResponseSseEvent[], RequestEndedEvent
└─ codemode.eval (continues same trace)
    └─ Events: CodeEvalStartedEvent, CodeEvalDoneEvent
```

All events in a request chain share the same `traceId`, enabling end-to-end tracing.

## User Message Interjection Modes

The `UserMessageEvent` supports a `mode` field that controls how new messages interact with in-flight LLM responses:

| Mode                  | Behavior                                             |
| --------------------- | ---------------------------------------------------- |
| `interrupt` (default) | Stop current response, start new request immediately |
| `queue`               | Don't interrupt, respond after current finishes      |
| `background`          | Add to history, no response triggered                |

Additionally, `CancelRequestEvent` can be sent to stop the current response without triggering a new one.

---

## Claude's Debug CLI

**Note to Claude:** This CLI (`src/debug-cli.ts`) is YOUR tooling for debugging and testing this codebase. If you find it lacking or need different information while working, iterate on it! Keep this documentation up to date as you improve the tools.

### Usage

```bash
tsx src/debug-cli.ts [PATH] COMMAND [ARGS]
```

### Path Selection

The stream path is determined in priority order:

1. First arg if it contains `/` or matches an existing `.yaml` file
2. `STREAM_PATH` env var
3. Default: `test/modes`

### YAML Queries (offline)

```bash
# Show conversation flow (user/assistant messages with modes)
tsx src/debug-cli.ts convo
tsx src/debug-cli.ts chat/room1 convo         # specific path

# Show request lifecycle (started → ended/cancelled)
tsx src/debug-cli.ts requests

# Show events with filters
tsx src/debug-cli.ts events --last=20         # last N events
tsx src/debug-cli.ts events --type=cancelled  # filter by type
tsx src/debug-cli.ts events --around=0000000000000015  # context around offset

# Search YAML content
tsx src/debug-cli.ts search "interrupted"
```

### Interactive Testing (requires server)

```bash
# Enable openai model first
tsx src/debug-cli.ts config

# Send message and wait for response
tsx src/debug-cli.ts chat "Hello"
tsx src/debug-cli.ts chat "message" --queue
tsx src/debug-cli.ts chat "message" --background

# Cancel current request
tsx src/debug-cli.ts stop

# Run stress test of all modes
tsx src/debug-cli.ts stress
```

### What to Look For

- `convo` - Quick view of conversation flow, shows `[interrupted]` markers and `[queue]`/`[background]` modes
- `requests` - Shows which requests completed vs were cancelled, helpful for debugging mode behavior
- `events --type=cancelled` - Find all interrupted/failed requests
- `search "response interrupted"` - Check if the `[response interrupted by user]` marker is being added
