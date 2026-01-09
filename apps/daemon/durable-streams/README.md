# Durable Streams

Pure event streams with append/subscribe semantics. No LLM logic, no agent behavior - just ordered, persistent event logs.

## Design Philosophy

**Streams are named, ordered event logs.** Each stream:
- Has a unique name
- Contains events with monotonically increasing offsets
- Supports append (write) and subscribe (read)
- Provides fan-out to multiple subscribers

**CLI wraps HTTP.** The CLI doesn't talk to streams directly - it talks to an HTTP server. This decouples client from storage and enables remote operation.

**Auto-daemon for local use.** Stream commands auto-start a local server if none running. No manual server management needed for simple use cases.

## Architecture

Each layer is expressible entirely in terms of the layer below (onion model).

```
┌─────────────────────────────────────────────────────────────┐
│                         CLI Layer                          │
│  stream subscribe/append → HTTP client → server            │
│  server run/start/stop   → daemon management               │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                   HTTP Routes (Layer 5)                    │
│  POST /streams/:name         → append event                │
│  GET  /streams/:name         → subscribe (SSE)             │
│  GET  /streams/:name/events  → get historic events         │
│  GET  /streams               → list streams                │
│  DELETE /streams/:name       → delete stream               │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                   StreamManager (Layer 4)                  │
│  getStream() → lazy init + cache via factory               │
│  append/subscribe/list/delete                              │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│               DurableStreamFactory (Layer 3)               │
│  Plain       → returns base DurableStream                  │
│  WithHooks   → wraps with before/after hooks               │
│  ActiveFactory → change one line to swap implementations   │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                    withHooks (Layer 2)                     │
│  Pure wrapper function for hook composition                │
│  Before hooks: veto append on failure (HookError)          │
│  After hooks: log errors but don't fail                    │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                   DurableStream (Layer 1)                  │
│  Per-stream state: offset counter, PubSub                  │
│  append() → increment offset, store, broadcast             │
│  subscribe() → historical catchup + live PubSub            │
│  Pure stream primitive - no hook concept                   │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                     Storage (Layer 0)                      │
│  InMemory (tests) | FileSystem (production)                │
│  Data persisted in .iterate/streams/*.json                 │
└─────────────────────────────────────────────────────────────┘
```

## Hooks System

Hooks allow intercepting stream operations without modifying the base `DurableStream` implementation.

### Hook Types

**Before hooks** run before append. Failure vetoes the operation:
```typescript
const validateType: BeforeAppendHook = {
  id: "validate-type",
  run: ({ data }) => {
    const obj = data as Record<string, unknown>
    if (typeof obj._type !== "string") {
      return Effect.fail(new HookError({
        hookId: "validate-type",
        message: "Data must have _type field"
      }))
    }
    return Effect.void
  }
}
```

**After hooks** run after successful append. Errors are logged but don't fail:
```typescript
const auditLog: AfterAppendHook = {
  id: "audit-log",
  run: ({ name, event }) =>
    Effect.log("Event appended", { stream: name, offset: event.offset })
}
```

### Using withHooks

Wrap any `DurableStream` with hooks:
```typescript
import { withHooks } from "./with-hooks.ts"

const hooked = withHooks(baseStream, {
  beforeAppend: [validateType, rateLimit],
  afterAppend: [auditLog, notifyDownstream]
})
```

### Swapping Implementations

Edit `stream-factory.ts` to change `ActiveFactory`:
```typescript
// Default: plain streams (no hooks)
export const ActiveFactory = PlainFactory

// To test validation hooks:
export const ActiveFactory = ValidatedFactory

// To test agent event hooks:
export const ActiveFactory = EmbryonicAgentFactory
```

Pre-configured variants in `stream-factory.ts`:
- `PlainFactory` - base DurableStream, no hooks
- `ValidatedFactory` - requires `_type` field on all events
- `EmbryonicAgentFactory` - validates agent events (`_type` starts with `agent:`) + logging

## CLI Reference

### Server Commands

```bash
# Run server in foreground (blocks)
npx tsx src/durable-streams/main.ts server run --port 3000

# Run with in-memory storage (no persistence)
npx tsx src/durable-streams/main.ts server run --storage memory

# Start daemonized server (returns immediately)
npx tsx src/durable-streams/main.ts server start --port 3000

# Start daemon with in-memory storage
npx tsx src/durable-streams/main.ts server start --storage memory

# Stop daemon
npx tsx src/durable-streams/main.ts server stop

# Restart daemon
npx tsx src/durable-streams/main.ts server restart --port 3000

# Check daemon status
npx tsx src/durable-streams/main.ts server status
```

**Storage options:**
- `--storage fs` (default) - Persistent file-based storage in `.iterate/streams/`
- `--storage memory` - Volatile in-memory storage (data lost on restart)

### Stream Commands

```bash
# Subscribe to stream (outputs JSON lines - waits for live events)
npx tsx src/durable-streams/main.ts stream subscribe -n my-stream

# Subscribe from beginning (offset -1)
npx tsx src/durable-streams/main.ts stream subscribe -n my-stream --offset -1

# Get historic events (one-shot, exits after fetching)
npx tsx src/durable-streams/main.ts stream get -n my-stream

# Get events with offset and limit
npx tsx src/durable-streams/main.ts stream get -n my-stream --offset 0000000000000005 -l 10

# Append message (auto-wraps as {type:"message",text:"..."})
npx tsx src/durable-streams/main.ts stream append -n my-stream -m "hello world"

# Append raw JSON
npx tsx src/durable-streams/main.ts stream append -n my-stream -e '{"custom":"data"}'

# List all streams
npx tsx src/durable-streams/main.ts stream list

# Delete stream
npx tsx src/durable-streams/main.ts stream delete -n my-stream
```

### Environment Variables

- `DURABLE_STREAMS_URL` - Server URL (skips auto-daemon)

### Files Created

Data files are stored in `.iterate/` in the working directory:
- `.iterate/daemon.pid` - Process ID of running daemon
- `.iterate/daemon.port` - Port the daemon is listening on
- `.iterate/daemon.log` - Server stdout/stderr
- `.iterate/streams/*.json` - Persisted event streams

## Testing with tmux

Multi-window setup for interactive testing:

```bash
# Create tmux session with 3 panes
tmux new-session -d -s ds
tmux split-window -h -t ds
tmux split-window -v -t ds:0.1

# Pane 0: Server
tmux send-keys -t ds:0.0 'npx tsx src/durable-streams/main.ts server run' Enter

# Pane 1: Subscriber (wait for server to start)
tmux send-keys -t ds:0.1 'sleep 1 && npx tsx src/durable-streams/main.ts stream subscribe -n test --offset -1' Enter

# Pane 2: Publisher
tmux send-keys -t ds:0.2 'sleep 2' Enter

# Attach to session
tmux attach -t ds
```

Then in pane 2, send messages:
```bash
npx tsx src/durable-streams/main.ts stream append -n test -m "first message"
npx tsx src/durable-streams/main.ts stream append -n test -m "second message"
npx tsx src/durable-streams/main.ts stream append -n test -e '{"type":"custom","payload":123}'
```

Watch them appear in pane 1 (subscriber).

## HTTP API Examples

### Append Event

```bash
curl -X POST http://localhost:3000/streams/my-stream \
  -H "Content-Type: application/json" \
  -d '{"data": {"type": "message", "text": "hello"}}'
```

Response:
```json
{"offset":"0000000000000000","eventStreamId":"my-stream","data":{"type":"message","text":"hello"},"createdAt":"2024-01-08T00:00:00.000Z"}
```

### Subscribe (SSE)

```bash
# Subscribe from current position
curl -N http://localhost:3000/streams/my-stream

# Subscribe from beginning
curl -N http://localhost:3000/streams/my-stream?offset=-1

# Subscribe from specific offset
curl -N http://localhost:3000/streams/my-stream?offset=0000000000000005
```

Output (SSE format):
```
data: {"offset":"0000000000000000","eventStreamId":"my-stream","data":{"type":"message","text":"hello"},"createdAt":"2024-01-08T00:00:00.000Z"}

data: {"offset":"0000000000000001","eventStreamId":"my-stream","data":{"type":"message","text":"world"},"createdAt":"2024-01-08T00:00:01.000Z"}
```

### Get Historic Events

```bash
# Get all events from stream
curl http://localhost:3000/streams/my-stream/events

# Get events with offset and limit
curl http://localhost:3000/streams/my-stream/events?offset=0000000000000005&limit=10
```

Response:
```json
{"events":[{"offset":"0000000000000005","eventStreamId":"my-stream","data":{"type":"message","text":"hello"},"createdAt":"2024-01-08T00:00:00.000Z"}]}
```

### List Streams

```bash
curl http://localhost:3000/streams
```

Response:
```json
{"streams":["my-stream","another-stream"]}
```

### Delete Stream

```bash
curl -X DELETE http://localhost:3000/streams/my-stream
```

## Event Structure

```typescript
interface Event {
  offset: string        // Zero-padded 16-char number ("0000000000000042")
  eventStreamId: string // Name of the stream this event belongs to
  data: unknown         // Your payload
  createdAt: string     // ISO 8601 timestamp ("2024-01-08T00:00:00.000Z")
}
```

Offsets are lexicographically sortable strings. Special offset `-1` means "start from beginning".

## Key Files

| File | Purpose |
|------|---------|
| `cli.ts` | CLI command definitions |
| `main.ts` | Entry point |
| `daemon.ts` | Daemon management (start/stop/status) |
| `client.ts` | HTTP client with auto-daemon |
| `http-routes.ts` | HTTP route handlers (Layer 5) |
| `stream-manager.ts` | Stream lifecycle management (Layer 4) |
| `stream-factory.ts` | Factory service + ActiveFactory (Layer 3) |
| `with-hooks.ts` | Hook wrapper function (Layer 2) |
| `hooks.ts` | Hook types and HookError |
| `stream.ts` | Core DurableStream implementation (Layer 1) |
| `storage.ts` | Storage backend interface (Layer 0) |
| `types.ts` | Type definitions |
