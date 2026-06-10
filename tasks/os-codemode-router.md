---
state: todo
priority: high
size: large
dependsOn: []
---

# os codemode router

Lightweight codemode system for os: execute user code in an isolated dynamic worker sandbox with pluggable tool providers, streaming event-sourced results via oRPC.

## Core concepts

- **ToolProvider** — resolved interface with two methods: `execute(path: string[], payload: unknown) => Promise<unknown>` and `describe() => Promise<ToolProviderDescription>` (where `ToolProviderDescription = { typeDefinitions: string }`). Both local and remote providers implement this.
- **CallableToolProvider** — serializable wire format: `{ path: string[], execute: Callable, describe?: Callable }`. A recipe for constructing a `ToolProvider` by wrapping `dispatchCallable` around each callable.
- **Provider array** — the oRPC input is a flat `CallableToolProvider[]`, not a nested tree. The handler validates no path conflicts (no path is a prefix of another). The nested proxy/dispatcher structure is an internal implementation detail.
- **Paths are `string[]`** everywhere, never dotted strings. Follows oRPC's internal model.
- **Leaf-or-branch, never both** — a path is either a provider (leaf) or a namespace (implicit from shared path prefixes), never both.

## Event stream

The `execute` endpoint returns an `eventIterator` (oRPC SSE/WebSocket streaming). Events are past-tense, event-sourced style. Every event carries `{ blockId: string, timestamp: string }`.

Stream ordering:

1. N x `codemode-tool-provider-registered` — `{ path: string[] }` — one per provider
2. N x `codemode-tool-provider-described` — `{ path: string[], typeDefinitions: string }` — only for providers with `describe` callable (sequential, all resolved before execution starts)
3. `codemode-block-added` — `{ code: string }` — announces execution
4. Interleaved during execution:
   - `codemode-log-emitted` — `{ level: "log" | "warn" | "error", message: string }`
   - `codemode-tool-call-requested` — `{ callId: string, path: string[], payload: unknown }`
   - `codemode-tool-call-succeeded` — `{ callId: string, result: unknown }`
   - `codemode-tool-call-failed` — `{ callId: string, error: string }`
5. `codemode-block-result-added` — `{ result: unknown, error?: string }` — final event

`blockId` is optionally provided by the caller, otherwise generated via the shared random string generator (prefix `cblk_`). `callId` generated host-side per tool call (prefix `ccal_`).

## oRPC procedures

### `execute`

- Input: `{ code: string, blockId?: string, providers: CallableToolProvider[] }`
- Output: `eventIterator(CodemodeEvent)` — the full event stream above
- Handler is `async function*` using oRPC's eventIterator pattern (already proven in os's `test.randomLogStream`)

### `describe`

- Input: `{ providers: CallableToolProvider[] }`
- Output: `{ typeDefinitions: string }` — assembled nested TypeScript declarations
- Plain request/response, no streaming

## Architecture

### Streaming: sandbox → host → oRPC consumer

Three layers:

1. **Sandbox → host**: `LogDispatcher` (RpcTarget, like ToolDispatcher) passed from host to sandbox. Sandbox's monkey-patched `console.log` calls `__logger.log(message)` via Workers RPC. Tool call events emitted by the host-side ToolDispatcher before/after dispatching to the provider.
2. **Host → async generator**: Push→pull bridge. Callbacks push events into a queue, the async generator yields them as they arrive. Completes when execution finishes.
3. **Async generator → client**: oRPC eventIterator handles SSE/WebSocket transport automatically.

### Bridge entrypoints

New directory: `apps/os/src/entrypoints/` (alongside `durable-objects/`), re-exported from the main worker for loopback binding resolution.

- **OpenApiBridge** — `WorkerEntrypoint` with props `{ specUrl: string, baseUrl: string }`. Stateless. Translates `execute(path, payload)` into HTTP calls derived from the spec. `describe()` parses the spec and generates type definitions. Referenced via loopback-binding callables with different props per API.
- **MCP bridge** — future, likely a Durable Object (stateful connection/session). Referenced via loopback DO namespace binding.

Higher-level provider types (MCP, OpenAPI) always compile down to `CallableToolProvider`. The execute endpoint only sees `CallableToolProvider[]`. Bridges are adapters that produce the right callable descriptors.

## Code location

### `packages/shared/src/codemode/`

Copied from `@cloudflare/codemode` (cloudflare/agents repo, iterate fork), adapted:

- `executor.ts` — DynamicWorkerExecutor, ToolDispatcher, LogDispatcher. Adapted for `string[]` paths, event emission callbacks.
- `normalize.ts` — strip markdown fences, wrap in async arrow
- `utils.ts` — sanitizeToolName, sanitizeToolPath
- `type-tree.ts` — nested declaration tree builder
- `json-schema-types.ts` — JSON schema → TypeScript string

Each copied file has the source GitHub URL at the top. Tests copied alongside.

New files:

- `types.ts` — `ToolProvider` interface, `CallableToolProvider` Zod schema, `CodemodeEvent` discriminated union, `ToolProviderDescription`
- `resolve.ts` — `resolveCallableToolProvider(descriptor, ctx) => ToolProvider` (wraps dispatchCallable around callables)
- `validate.ts` — path conflict detection, provider array validation

### `apps/os/src/orpc/routers/codemode.ts`

The oRPC procedures: `execute` and `describe`.

### `apps/os/src/entrypoints/`

Bridge entrypoints: `openapi-bridge.ts` (future: `mcp-bridge.ts`).

### `apps/os-contract/src/index.ts`

Contract additions for the codemode procedures.

## Testing strategy

### Layer 1: Unit tests (`packages/shared/src/codemode/*.test.ts`)

Plain vitest, no workerd:

- Code normalization
- Path sanitization/utils
- Type generation (JSON schema → TS strings)
- CallableToolProvider schema validation
- CodemodeEvent schema validation
- Path conflict detection
- Event stream ordering validation

### Layer 2: Workerd integration tests (`packages/shared/src/codemode/*.workerd.test.ts`)

vitest-pool-workers with LOADER binding (same setup as callable's wrangler.vitest.jsonc):

- Executor: code runs, returns results, errors/timeouts
- Tool dispatch: sandbox calls tools, results/errors propagate
- LogDispatcher: streams logs back via RPC
- Event emission: tool-call-requested/succeeded/failed events
- Push→pull async generator bridge

### Layer 3: E2E tests (`apps/os/e2e/vitest/codemode.e2e.test.ts`)

Plain vitest hitting real HTTP endpoints via oRPC client against `OS_BASE_URL`. Runnable against dev or deployed:

- Call `execute`, verify event stream shape and ordering
- Call `execute` with loopback OpenApiBridge providers
- Call `describe`, verify type string output
- Path conflict rejection
- blockId generation
- MCP server tools: `addToolProvider`, `describeToolProviders`, `runCode`

## Additional requirements

### MCP server tools

OS's MCP server gains tools:

- `addToolProvider` — register a CallableToolProvider
- `describeToolProviders` — call describe on all registered providers, return types
- `runCode` — execute code against registered providers, stream results

### UI

Simple form UI in apps/os (similar to apps/codemode):

- Code editor textarea
- Provider list/selection
- Run button → streams events into a log view
- Result display

## Manual testing

### Testing the MCP server with Claude CLI

```bash
# Add the MCP server temporarily (project-scoped, from apps/os/)
claude mcp add --transport http os-test https://os.iterate-dev-jonas.com/mcp --scope project

# Test it in non-interactive mode
claude -p 'Use run_code to compute 6 * 7' --allowedTools "mcp__os-test__run_code"
# Expected output: 42

# Clean up
claude mcp remove os-test --scope project
```

### Testing the oRPC endpoint with curl

```bash
# Execute code via OpenAPI endpoint (SSE response)
curl -s 'https://os.iterate-dev-jonas.com/api/codemode/execute' \
  -X POST -H 'content-type: application/json' \
  -d '{"code":"async () => 1 + 1","providers":[]}'

# Describe providers (plain JSON response)
curl -s 'https://os.iterate-dev-jonas.com/api/codemode/describe' \
  -X POST -H 'content-type: application/json' \
  -d '{"providers":[{"path":["test"],"execute":{"type":"fetch","via":{"type":"url","url":"https://httpbin.org/post"}}}]}'
```

### Testing MCP protocol directly with curl

```bash
# Initialize session (capture mcp-session-id header)
curl -sv 'https://os.iterate-dev-jonas.com/mcp' \
  -X POST -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}'

# List tools (use session ID from previous response)
curl -s 'https://os.iterate-dev-jonas.com/mcp' \
  -X POST -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -H 'mcp-session-id: <SESSION_ID>' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'

# Call run_code
cat <<'EOF' | curl -s 'https://os.iterate-dev-jonas.com/mcp' \
  -X POST -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -H 'mcp-session-id: <SESSION_ID>' -d @-
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"run_code","arguments":{"code":"async () => Math.PI"}}}
EOF
```

### Testing the UI

Visit `https://os.iterate-dev-jonas.com/codemode` — write code, click Run, see streaming events.

## Implementation order

1. **Kernel** — `packages/shared/src/codemode/`: copy adapted executor + utils + tests, new types/schemas, resolve/validate logic
2. **oRPC endpoints** — contract additions, `execute` (streaming) and `describe` procedures, LOADER binding setup, push→pull bridge
3. **MCP server tools** — thin layer over the oRPC endpoints
4. **UI** — form + streamed event display
5. **Bridge entrypoints** — OpenApiBridge WorkerEntrypoint
