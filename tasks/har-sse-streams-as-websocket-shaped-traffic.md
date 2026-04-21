---
state: todo
priority: medium
size: large
dependsOn: []
---

# HAR: treat long-lived SSE (e.g. MCP Streamable HTTP GET) like WebSocket-shaped traffic

## Problem

MCP **Streamable HTTP** clients (see `@modelcontextprotocol/sdk` `StreamableHTTPClientTransport`) issue an optional **GET** to the MCP URL with `Accept: text/event-stream` before relying on **POST** for JSON-RPC. Real servers such as `https://docs.mcp.cloudflare.com/mcp` respond with **HTTP 200** and a **non-terminating** `text/event-stream` body.

Today, `packages/mock-http-proxy` records HTTP by buffering the **full** response (`arrayBuffer()` on the `Response` in `mock-http-server-fixture.ts` / passthrough path). For SSE, that buffer **never completes** while the upstream keeps the connection open, so:

- the exchange may never be finalized for the HAR, or
- recording blocks until the connection closes (impractical for e2e).

Committed HAR fixtures therefore naturally emphasize **POST** JSON-RPC exchanges. Optional GET/SSE is either missing, stubbed (e.g. synthetic **405** handlers in `apps/agents/e2e/test-support/mcp-streamable-http-get-stub-handlers.ts`), or would leak to the real network under strict `onUnhandledRequest: "error"` if not handled separately.

The user goal: **fixtures should reflect real protocol behavior** where possible; where impossible to store one finite `response.content.text`, we need a **different representation**—the same way we already special-case **WebSockets**.

## What “like WebSockets” means here

WebSocket traffic is **not** stored as a single HTTP response body. Chrome-style HAR extensions model it as:

- `_resourceType: "websocket"`
- `_webSocketMessages`: ordered `{ type: "send" | "receive", time, opcode, data }`

See `packages/mock-http-proxy/src/har/har-extensions.ts` and the WebSocket recording path in `mock-http-server-fixture.ts` (passthrough upgrade → `bridgeWebSocketToUpstream` → append framed messages).

**Analogy for SSE:**

| WebSocket                | SSE (this task)                                                                                                         |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| Upgrade request + 101    | Single **GET** request + **200** (headers matter)                                                                       |
| Bidirectional **frames** | **Server → client** event stream only (client “send” on this connection is empty; separate POSTs carry client JSON-RPC) |
| `_webSocketMessages[]`   | **`_sseMessages[]`** (or reuse a neutral name like `_streamMessages` with `direction` / `kind`)                         |
| `time` + opaque `data`   | `time` + **raw event block** (or parsed `event` / `id` / `data` fields)                                                 |

SSE is **half-duplex on one HTTP response**: one GET, many server-delimited chunks. Treat each **SSE event block** (per spec: lines until blank line) as one **logical message** in the journal, similar to one WS text frame.

## Proposed HAR shape (extensions)

Add optional fields on `HarEntryWithExtensions` (names are illustrative):

- `_resourceType: "server-sent-events"` (or `"sse"`) on the **GET** entry whose `response.content.mimeType` is `text/event-stream`.
- `_sseMessages`: array of:
  - `time: number` — monotonic, same convention as `_webSocketMessages` (seconds with fractional part is fine if that matches existing WS recorder).
  - `name?: string` — SSE `event:` line if present.
  - `id?: string` — `id:` line if present (important for `Last-Event-ID` / resumption tests).
  - `data: string` — concatenated `data:` lines for that event (or raw block text if simpler v1).

Optional metadata under `_iterateMetadata` (already exists for truncation flags):

- `sseRecordingPolicy: "first_n_events" | "time_budget_ms" | "until_session_ready"`
- `sseRecordedReason: "closed" | "budget_exhausted" | "parser_error"`

## Recording strategy (must be bounded)

Unlike a POST/response pair, an MCP SSE stream may run forever. Recording **must** stop under an explicit policy so the HAR stays finite and e2e stays fast.

Reasonable policies (pick one or compose):

1. **Time budget** — After response headers arrive, read the body stream for at most `T` ms (e.g. 500–2000ms), parse SSE incrementally, append messages, then **cancel** the reader and finalize the HAR entry with `responseBodyTruncated: true`-style metadata.
2. **Event count** — Stop after `N` parsed event blocks (e.g. enough to see `endpoint` / `session` / first JSON-RPC over SSE if applicable).
3. **Idle / delimiter** — Stop after first “meaningful” server event for MCP (product-specific; brittle).
4. **Parallel correlation** — If MCP ties GET stream to POST via `mcp-session-id` header, record until that session emits a known ready signal (more complex).

**Passthrough path change:** In `onPassthroughResponse` (and any path that clones the full `Response`), detect `Content-Type: text/event-stream` (and optionally `GET` + MCP URL patterns) and **do not** call `arrayBuffer()` on the full body. Instead:

- pipe through an SSE parser (see `@modelcontextprotocol/sdk` / `eventsource-parser` — already in the tree via MCP SDK),
- push into `_sseMessages`,
- truncate per policy,
- store a **synthetic** response body in HAR for round-trip debugging: either empty, or the **concatenation of recorded blocks** (lossy but readable), with truncation flags.

## Replay strategy

**MSW `http.get`:** Return `HttpResponse` with:

- Status and headers from HAR (including `content-type: text/event-stream`, `cache-control`, etc.).
- `body` = **`ReadableStream`** that **replays** `_sseMessages` as SSE-formatted bytes (each event → `event:` / `data:` / `\n\n`), at **recorded** or **accelerated** timing (for tests, immediate chunks are usually enough; optional delay for race coverage).

**`fromTraffic` integration:** Extend `fromTrafficWithWebSocket` (`packages/mock-http-proxy/src/replay/from-traffic-with-websocket.ts`) or add `fromTrafficWithSse`:

- For entries with `_resourceType` SSE + `_sseMessages`, register an `http.get` handler that matches the same URL/method/Headers predicate `fromTraffic` uses for HTTP.
- Ensure ordering relative to other handlers (POST JSON-RPC from same host should remain separate entries—likely already distinct HAR entries).

## Relationship to MCP semantics

- **405 on GET** is valid per SDK (“no SSE at this URL”) and is **not** what Cloudflare returns when SSE is enabled; it is only a convenient stub for tests.
- Faithful SSE replay lets tests assert **200 + stream** without hitting the internet, while POST HAR entries continue to carry JSON-RPC tool calls.
- If the server sends errors as SSE or interleaved JSON, recorded `_sseMessages` should capture them as discrete events.

## Implementation sketch (incremental)

1. **Types** — Extend `HarEntryWithExtensions` in `har-extensions.ts` with `_sseMessages` + `_resourceType` for SSE.
2. **Recorder** — In `HarRecorder` / `HarJournal`, support appending an SSE exchange with **pre-broken** body chunks (or add `appendSseExchange` parallel to `appendWebSocketExchange`).
3. **Native server** — Branch passthrough recording for SSE: bounded read → finalize entry; never block on infinite `arrayBuffer()`.
4. **Replay** — Handlers that rebuild `ReadableStream` from `_sseMessages`.
5. **Agents e2e** — Replace or narrow `mcpStreamableHttpGetStubHandlers` once MCP GET is represented in committed HARs; keep hostname rewrite (`prepareAgentsHarForReplay`) aligned with Events URLs only.
6. **Tests** — Unit tests in `mock-http-proxy`: record synthetic SSE upstream (short stream), assert HAR JSON; replay with `onUnhandledRequest: "error"`, assert client sees events.

## Risks / open questions

- **Header-sensitive matching:** MCP GET requires correct `mcp-protocol-version` etc.; replay handlers must key on the same predicate `fromTraffic` generates or tests will be flaky.
- **Compression:** SSE might use `Content-Encoding`; align with existing `decodeContentEncodings` behavior in `HarRecorder`.
- **Session resumption:** `Last-Event-ID` / reconnect could create multiple GETs; model as separate HAR entries or one entry with multiple `_sseMessages` segments—decide one convention.
- **Non-MCP SSE:** Keep the feature **generic** (`text/event-stream`) so Events or other SSE endpoints can reuse the same machinery.

## Success criteria

- E2E can run with **`onUnhandledRequest: "error"`** without MCP GET hitting the real internet **and** without synthetic 405 unless we explicitly choose to assert the “no SSE” path.
- Committed HARs contain a **finite**, **replayable** representation of the SSE side of Streamable HTTP for the recorded run.
- Documentation in `packages/mock-http-proxy/README.md` describes SSE extensions alongside WebSocket.
