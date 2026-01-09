# Iterate Agent Architecture

## What We're Building

Iterate orchestrates AI coding agents (OpenCode, Claude Code, Pi, and our own Iterate Agent) through **durable event streams**. Each agent has its own stream. Harness adapters react to stream events and call harness APIs.

```
External events
  slack:webhook-received
  github:webhook-received
  ...
    │
    ▼
┌─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                                                                                                                                 │
│                                                          AGENT STREAM (per agent)                                                               │
│                                                                                                                                                 │
└─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
          │     ▲                                                                                                       │     ▲
          │     │                                                                                                       │     │
subscribe │     │ append                                                                                      subscribe │     │ append
          │     │                                                                                                       │     │
          │     │   iterate:agent:harness:opencode:action:prompt:called                                                 |     |
          │     │   iterate:agent:action:send-user-message:called                                                       |     |
          │     │   iterate:agent:harness:opencode:action:session-create:called                                         │     │
          │     │                                                                                                       │     │
          │     │   iterate:agent:harness:opencode:event-received                                                       │     │
          │     │   iterate:agent:harness:pi:event-received                                                             │     │
          │     │   iterate:agent:harness:claude:event-received                                                         │     │
          │     │   iterate:agent:harness:iterate:event-received                                                        │     │
          │     │                                                                                                       │     │
          ▼     │                                                                                                       ▼     │
┌────────────────────────────────────────────────────────────────────────────────────────────┐    ┌───────────────────────────────────────────────┐
│                                                                                            │    │                                               │
│                                 HARNESS ADAPTERS                                           │    │                    RENDERERS                  │
│                                    (our code)                                              │    │                                               │
│                                                                                            │    │                Web UI    CLI/TUI              │
│                      OpenCode    Claude    Pi    Iterate                                   │    │                                               │
│                                                                                            │    │         Subscribe to stream, display          │
│           Subscribe to stream, append action events,                                       │    │         events. User types message →          │
│           call harness APIs, wrap harness output                                           │    │         append control event.                 │
│                                                                                            │    │                                               │
└────────────────────────────────────────────────────────────────────────────────────────────┘    └───────────────────────────────────────────────┘
          │     ▲
          │     │
 call API │     │ subscribe to
          │     │ harness events
          │     │
          ▼     │
┌────────────────────────────────────────────────────────────────────────────────────────────┐
│                                                                                            │
│                                  HARNESS RUNTIMES                                          │
│                                     (their code)                                           │
│                                                                                            │
│                      OpenCode Server    Claude SDK    Pi SDK    Iterate Agent              │
│                                                                                            │
│           Native agent runtimes. Emit their own events.                                    │
│           We subscribe to these and wrap them.                                             │
│                                                                                            │
└────────────────────────────────────────────────────────────────────────────────────────────┘
```

**Key properties:**
- One durable stream per agent instance / session (identified by `eventStreamId`)
- Action events are first-class stream events (Redux-like pattern) - adapters observe the actions and enact side effects (e.g. sending a prompt to opencode)
- Harness events wrapped verbatim in `payload` (no lossy normalization)
- Renderers are bidirectional (can read and append events)
- Native TUIs remain fully functional (SSH in, use OpenCode/Claude/Pi directly)

## Terminology

| Term | Definition |
|------|------------|
| **Agent Harness** | Standalone agent runtime (OpenCode, Claude Code, Pi, Iterate Agent). Handles LLM calls, tool execution, conversation state. |
| **Harness Adapter** | Code that subscribes to a stream, appends events, and interacts with a harness SDK/CLI. |
| **Durable Stream** | Append-only event log with offset-based resumption. One stream per agent instance. |
| **Event Stream ID** | Unique identifier for a stream (e.g., `"stream-abc123"`). Used everywhere instead of "agent ID". |
| **Action Event** | Event requesting a side effect (e.g., `action:prompt:called`). Uses `action:*:called` naming. |
| **Renderer** | Bidirectional stream client (Web UI, Slack bot). Can read events and append new ones. |

## The Core Pattern: Durable Streams

**A durable stream has exactly three operations:**

1. **Subscribe** — get events as they arrive (with offset-based resumption)
2. **Get history** — read past events from a given offset
3. **Append** — add new events to the stream

That's it. If you want to support a new agent harness, you need to:
1. Subscribe to the stream
2. Append events to the stream
3. Interact with the harness SDK/CLI

Nothing else. No special interfaces, no framework abstractions. Just subscribe, append, and call the SDK.

## Event Architecture

### Event Types (examples)

```
External events (from outside world):
  slack:webhook-received
  github:webhook-received
  ...

Action events (requesting side effects):
  iterate:agent:harness:opencode:action:session-create:called
  iterate:agent:harness:opencode:action:prompt:called
  iterate:agent:harness:claude:action:prompt:called
  iterate:agent:harness:pi:action:prompt:called
  iterate:agent:harness:iterate:action:prompt:called
  ...

Wrapped harness events (verbatim payload):
  iterate:agent:harness:opencode:event-received
  iterate:agent:harness:claude:event-received
  iterate:agent:harness:pi:event-received
  iterate:agent:harness:iterate:event-received
  ...
```

**Naming conventions:**
- External events: source-based (`slack:*`, `github:*`), past-tense verbs
- Action events: `action:*:called` suffix (things we want to happen)
- Wrapped harness: generic `event-received` type, native format in `payload`
- Colon separator: URL-safe, clear hierarchy

### Event Envelope

```typescript
interface IterateEvent {
  // Protocol fields
  offset: string                    // Assigned by durable-streams

  // Envelope fields (always present)
  type: string                      // e.g. "iterate:agent:harness:opencode:event-received"
  version: number                   // Schema version (start at 1)
  createdAt: string                 // ISO 8601 (e.g. "2024-01-15T10:15:00.000Z")
  eventStreamId: string             // Stream this event belongs to

  // Type-specific fields
  payload?: Record<string, unknown>

  // Optional
  metadata?: Record<string, unknown>  // Debug info, correlation IDs
}
```

Flat structure at root for easy filtering/indexing. External payloads preserved byte-for-byte in `payload` field.

### Example Events

```typescript
// 1. External event arrives
{
  type: "slack:webhook-received",
  version: 1,
  createdAt: "2024-01-15T10:15:00.000Z",
  eventStreamId: "stream-abc123",
  payload: {
    type: "message",
    channel: "C123",
    user: "U456",
    text: "Hello agent"
  }
}

// 2. Harness adapter transforms to action event
{
  type: "iterate:agent:harness:opencode:action:prompt:called",
  version: 1,
  createdAt: "2024-01-15T10:15:00.100Z",
  eventStreamId: "stream-abc123",
  payload: {
    content: "Hello agent"
  }
}

// 3. Harness adapter executes action, wraps response
{
  type: "iterate:agent:harness:opencode:event-received",
  version: 1,
  createdAt: "2024-01-15T10:15:01.500Z",
  eventStreamId: "stream-abc123",
  payload: {
    type: "Session.Message.Created",      // OpenCode's native format
    timestamp: 1705312799500,             // OpenCode's timestamp (their format)
    sessionId: "sess-456",
    message: { role: "assistant", parts: [...] }
  }
}
```

### Versioning Strategy

- `version` field in envelope, starting at 1
- Adding optional fields: no version bump
- Breaking changes: bump version, emit both during transition

## Agent Lifecycle

```typescript
// 1. Request agent creation (action event)
{ type: "iterate:agent:harness:opencode:action:session-create:called", version: 1, createdAt: "2024-01-15T10:15:00.000Z", eventStreamId: "stream-abc123", payload: { config: {...} } }

// 2. External event arrives
{ type: "slack:webhook-received", version: 1, createdAt: "2024-01-15T10:15:01.000Z", eventStreamId: "stream-abc123", payload: { channel: "C123", text: "Hello" } }

// 3. Adapter transforms to action
{ type: "iterate:agent:harness:opencode:action:prompt:called", version: 1, createdAt: "2024-01-15T10:15:01.100Z", eventStreamId: "stream-abc123", payload: { content: "Hello" } }

// 4. Harness events flow (verbatim wrapped)
{ type: "iterate:agent:harness:opencode:event-received", version: 1, createdAt: "2024-01-15T10:15:02.000Z", eventStreamId: "stream-abc123", payload: { type: "Session.Message.Created", ... } }
{ type: "iterate:agent:harness:opencode:event-received", version: 1, createdAt: "2024-01-15T10:15:02.500Z", eventStreamId: "stream-abc123", payload: { type: "Session.Message.Updated", ... } }

// 5. Destroy
{ type: "iterate:agent:harness:opencode:action:session-destroy:called", version: 1, createdAt: "2024-01-15T10:20:00.000Z", eventStreamId: "stream-abc123" }
```

## Harness Adapters: The Pattern

A harness adapter is just code that:
1. Subscribes to a durable stream
2. Appends events to the stream
3. Interacts with a harness SDK/CLI

No interfaces. No abstractions. Just the three stream operations + SDK calls.

### OpenCode Adapter (Complete Example)

```typescript
// OpenCode adapter - the entire implementation pattern
const runOpenCodeAdapter = (eventStreamId: string) => Effect.gen(function*() {
  const stream = yield* DurableStream
  const opencode = yield* OpenCodeClient

  // 1. Subscribe to stream events
  yield* stream.subscribe(eventStreamId, { fromOffset: "latest" }).pipe(
    Stream.runForEach((event) => Effect.gen(function*() {
      // Handle action events by calling OpenCode API
      if (event.type === "iterate:agent:harness:opencode:action:prompt:called") {
        yield* opencode.sendPrompt(event.payload.sessionId, event.payload.content)
      }
      if (event.type === "iterate:agent:harness:opencode:action:session-create:called") {
        yield* opencode.createSession(event.payload.config)
      }
      // Transform external events to action events
      if (event.type === "slack:webhook-received") {
        yield* stream.append(eventStreamId, {
          type: "iterate:agent:harness:opencode:action:prompt:called",
          eventStreamId,
          payload: { content: event.payload.text }
        })
      }
    }))
  )

  // 2. Subscribe to OpenCode's native events, wrap and append
  yield* opencode.subscribeEvents().pipe(
    Stream.runForEach((nativeEvent) =>
      stream.append(eventStreamId, {
        type: "iterate:agent:harness:opencode:event-received",
        eventStreamId,
        payload: nativeEvent  // Verbatim, no transformation
      })
    )
  )
})
```

**That's the whole pattern.** Subscribe to stream. Append to stream. Call SDK. Done.

### Event Flow (Slack → OpenCode)

```
slack:webhook-received arrives on stream
    │
    ▼
Adapter sees event, appends action:
  iterate:agent:harness:opencode:action:prompt:called
    │
    ▼
Adapter sees action event, calls:
  POST /session/:id/prompt_async
    │
    ▼
OpenCode SSE subscription receives native events
    │
    ▼
Wrapped as iterate:agent:harness:opencode:event-received
    │
    ▼
Appended to stream → Renderers see it
```

### Offset Tracking (Replay Safety)

Each adapter tracks its last-processed offset per stream in a simple file:

```
.iterate/adapter-offsets/opencode.json
{
  "stream-abc123": 42,
  "stream-def456": 17
}
```

On restart, adapter resumes from stored offset, skipping already-handled events. At-most-once semantics: if action execution fails, log and continue (don't retry).

## Harness Implementations

### OpenCode

HTTP/SSE server architecture. One server per sandbox, multiple sessions multiplexed.

```bash
opencode serve --port 4096
```

| Endpoint | Purpose |
|----------|---------|
| `/session` | List/create sessions |
| `/session/:id/prompt` | Send message (sync) |
| `/session/:id/prompt_async` | Send message (SSE stream) |
| `/session/:id/abort` | Cancel operation |
| `/event` | SSE event stream |

**Action handlers:**
- `action:session-create:called` → `POST /session`
- `action:prompt:called` → `POST /session/:id/prompt_async`
- `action:abort:called` → `POST /session/:id/abort`

**Event wrapping:** Subscribe to `/event` SSE, wrap each native event as `iterate:agent:harness:opencode:event-received`.

TUI attach: `opencode attach --hostname localhost --port 4096`

### Claude Code

CLI-per-invocation via SDK. SDK spawns CLI binary internally.

```typescript
import { query } from '@anthropic-ai/claude-agent-sdk'

const response = query({
  prompt: "Hello",
  options: {
    model: 'claude-sonnet-4-5',
    cwd: process.cwd(),
    resume: sessionId,
    allowedTools: ['Read', 'Write', 'Edit', 'Bash'],
    permissionMode: 'acceptEdits',
    abortController,
  }
})

for await (const message of response) {
  // Wrap as iterate:agent:harness:claude:event-received
}
```

**Startup overhead**: ~12 seconds per query (SDK spawns fresh CLI process).

**Global hooks** for CLI sessions (user SSH): Configure in `~/.claude/settings.json` to forward lifecycle events.

**Concurrency warning**: No file locking on sessions. Concurrent SDK + CLI access causes corruption.

TUI resume: `claude --resume <session-id>`

### Pi

Direct programmatic usage via `@mariozechner/pi-coding-agent` SDK. Eliminates subprocess overhead while maintaining CLI compatibility.

**Design philosophy**: "omit to discover, provide to override" — omit config options to use CLI-compatible auto-discovery, or provide explicit values.

**Primary exports:**
- `createAgentSession(options)` — Main factory returning `{ session }` for agent interaction
- `SessionManager` — Session file persistence (JSONL format) with static factory methods
- `discoverAuthStorage()` — Discovers credentials from `~/.pi/agent/auth.json` and env vars
- `discoverModels(authStorage)` — Discovers available models (built-in + custom `~/.pi/agent/models.json`)

**Session creation (mirrors CLI):**

```typescript
SessionManager.create()           // New session (auto-saves to ~/.pi/agent/sessions/)
SessionManager.open(path)         // Open specific file (--session /path/to/file.jsonl)
SessionManager.open("a8ec1c2a")   // Resume by partial UUID (--session a8ec1c2a)
SessionManager.continueRecent()   // Most recent session (-c or --continue)
SessionManager.inMemory()         // Ephemeral (--no-session)
SessionManager.list()             // List available sessions (-r or --resume)
```

**Event types (match RPC protocol):**

| Event Type | Description |
|------------|-------------|
| `agent_start` | Agent processing begins |
| `message_update` | Streaming text/thinking deltas; contains `assistantMessageEvent` |
| `turn_start` / `turn_end` | Turn boundaries (turns repeat while LLM calls tools) |
| `tool_call` | Tool about to execute |
| `tool_result` | Tool execution completed |
| `agent_end` | Agent processing complete |
| `error` | Error occurred |

**Complete adapter example:**

```typescript
import {
  createAgentSession,
  discoverAuthStorage,
  discoverModels,
  SessionManager,
} from "@mariozechner/pi-coding-agent"

// CLI-compatible configuration discovery
const authStorage = discoverAuthStorage()
const modelRegistry = discoverModels(authStorage)

// Create session with file persistence
const sessionManager = SessionManager.create()

const { session } = await createAgentSession({
  sessionManager,
  authStorage,
  modelRegistry,
  // Optional overrides: cwd, model, thinkingLevel, systemPrompt, tools, extensions
})

// Session file path for CLI interop (pi --session <path>)
console.log("Session file:", sessionManager.sessionFile)

// Subscribe to events
const unsubscribe = session.subscribe((event) => {
  switch (event.type) {
    case "message_update":
      if (event.assistantMessageEvent?.type === "text_delta") {
        // Stream text output, wrap as iterate:agent:harness:pi:event-received
        process.stdout.write(event.assistantMessageEvent.delta ?? "")
      }
      break
    case "tool_call":
      console.log(`[Tool: ${event.toolName}]`)
      break
    case "agent_end":
      console.log("[Agent finished]")
      break
  }
})

// Send prompts (async, returns when agent finishes)
await session.prompt("List TypeScript files")
await session.prompt("What patterns do you see?")

// Session methods
session.abort()           // Cancel current processing
await session.waitForIdle()
await session.branch()    // Fork conversation (like /branch)
await session.reset()     // Reset session (like /new)

unsubscribe()
```

**Resuming existing session:**

```typescript
const sessionManager = SessionManager.open(sessionPath)
const { session } = await createAgentSession({ sessionManager, authStorage, modelRegistry })
// History loaded from JSONL file, continue conversation
await session.prompt("Continue where we left off")
```

TUI resume: `pi --session /path/to/session.jsonl`

### Iterate Agent

Our own agent implementation. Details TBD—Effect-based LLM adapter.

### Comparison

| Aspect | OpenCode | Claude Code | Pi | Iterate Agent |
|--------|----------|-------------|-----|---------------|
| Architecture | HTTP/SSE server | CLI per query | Direct SDK | TBD |
| Concurrent safe | Yes (server) | No (file-based) | No (file-based) | TBD |
| Startup overhead | Server must run | ~12s per query | None (in-process) | TBD |
| CLI capture | Built-in (same server) | Global hooks needed | Same session file | N/A |

## Tool Injection

Iterate tools registered in each harness using harness-specific mechanisms:

| Harness | Registration |
|---------|-------------|
| OpenCode | Agent config or runtime SDK |
| Claude Code | MCP servers, `--allowedTools` |
| Pi | `extensions` option in `createAgentSession()` |
| Iterate Agent | Effect Schema directly |

**Approach**: Define tools using Effect Schema, convert to harness-specific format. Long-term: MCP as canonical format where supported.

## TUI Compatibility

Users can SSH into sandbox and use native TUI. When they do:
- From agent's perspective, everything is normal
- Adapter captures events → appear on SSE stream
- Web UI sees same events

**Handoff**: When TUI attaches, adapter detects and web UI shows takeover banner (optionally enters read-only mode). On TUI exit, web UI resumes.

## Renderers

Renderers are **bidirectional** stream clients. They can:
1. Subscribe to events via SSE (read)
2. Append new events to the stream (write)

Examples: Web UI, Slack bot, CLI.

```typescript
// Reading events
function handleStreamEvent(event: IterateEvent) {
  if (event.type === "iterate:agent:harness:opencode:event-received") {
    return renderOpenCodeEvent(event.payload)
  }
  if (event.type === "iterate:agent:harness:claude:event-received") {
    return renderClaudeEvent(event.payload)
  }
  if (event.type === "iterate:agent:harness:pi:event-received") {
    return renderPiEvent(event.payload)
  }
  if (event.type === "iterate:agent:harness:iterate:event-received") {
    return renderIterateEvent(event.payload)
  }
  // Show raw event for unknown types
  return renderRawEvent(event)
}

// Writing events (user sends message from Web UI)
async function onUserSubmit(eventStreamId: string, text: string) {
  await stream.append(eventStreamId, {
    type: "iterate:agent:harness:opencode:action:prompt:called",
    eventStreamId,
    payload: { content: text }
  })
}
```

Initial implementation: Show all events raw in a feed. Later: Rich rendering for user/assistant messages per harness.

---

## Open Questions

### Session Concurrency

**How to prevent file corruption for Claude Code/Pi?**

Ignore for now

### Event Deduplication

Ignore for now

### Process Supervision

**Who manages harness processes?**

- OpenCode: Hybrid auto-daemon (connect to existing, spawn if needed)
- Claude: SDK manages per-query
- Pi: In-process SDK (no process to manage)
- Iterate Agent: TBD

**Health monitoring?**
- Passive exit monitoring + periodic health checks

### Storage

**Duplication strategy**: We store the full wrapped harness events ourselves, separately to how the harness themselves does it. So technically harness events are stored twice - once by opencode/pi/claude and once wrapped by us.
