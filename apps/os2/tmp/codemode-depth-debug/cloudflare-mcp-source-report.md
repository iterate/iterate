# Cloudflare MCP + Source Report: codemode subrequest depth

Date: 2026-05-06
Branch: `raspy-produce`
Worker/account inspected: `os2-preview-2` in Cloudflare account `cc7f6f461fbe823c199da2b27f9e0ff3` via the general `mcp__cloudflare_api__` tools only.

## Finding

The best current explanation is confirmed: the failing path can recursively grow a Cloudflare subrequest chain through stream append fanout:

`StreamDurableObject.append` -> `StreamDurableObject.afterAppend` -> external callable subscriber -> `CodemodeSession.afterAppend` -> codemode processor consumes event -> appends derived events back to the same stream -> repeat.

This is not just theoretical. Recent `POST https://mcp__test.iterate-preview-2.app/` traces show the exact repeating pattern:

- `c63600045bb5494acdb067609b401c93`, 2026-05-06 17:14:14Z, 234 events/spans, error `Network connection lost.`
- `0602ded79b0fc1ac03e520a16b0e58f8`, 2026-05-06 17:13:10Z, 265 events/spans, error `Network connection lost.`
- `f10fd01470bc61a200668741cd450639`, 2026-05-06 17:12:44Z, 229 events/spans, no Cloudflare error in the trace summary but the same append/afterAppend expansion.

The small/success shape is different:

- `93c6874f37d7f53d85f2302e612a2cb5`, 2026-05-06 17:10:52Z, 21 events/spans, root `POST https://mcp__test.iterate-preview-2.app/` status 200, only one `StreamCapability.append` and one `StreamDurableObject.append`, no `CodemodeSession.startScriptExecution`, no `CodemodeSession.afterAppend`.

That matches the observed `providerLimit:0` success: when provider registration/script processing does not kick off the live codemode append fanout, the trace stays shallow and returns `Result: 2`.

## Source path

`packages/shared/src/streams/stream-durable-object.ts`

- `append()` commits the event, calls `this.afterAppend(event)`, then returns the event. See lines 211-247.
- `afterAppend()` calls `runBuiltinAfterAppend()` with `append: (nextEvent) => this.append(nextEvent)`. See lines 341-358.
- `runBuiltinAfterAppend()` invokes `externalSubscriberProcessor.afterAppend` and catches it asynchronously. See lines 644-653. This means append-derived work is not awaited by the original append caller, but it stays in the same trace/subrequest lineage.

`packages/shared/src/streams/external-subscriber.ts`

- `externalSubscriberProcessor.afterAppend()` publishes every committed event to every configured external subscriber. See lines 55-65.
- Callable subscribers call `dispatchSubscriberCallable()` for every matching event. See lines 101-107 and 187-198.

`apps/os2/src/durable-objects/codemode-session.ts`

- `ensureCallableSubscription()` configures a callable stream subscription targeting the same `CodemodeSession.afterAppend` RPC method. See lines 468-488.
- `afterAppend()` consumes each stream event through the codemode processor. See lines 212-220.
- `createSession()` appends provider-registration events, consumes them synchronously, then appends `script-execution-requested`. See lines 249-282.
- `processorStreamApiFromNamespace().append()` appends derived codemode events back to the stream. See lines 601-610.
- The dynamic-worker executor catches execution errors and returns them as `{ error }`, allowing them to become a failed `script-execution-completed` event instead of necessarily throwing the MCP call. See lines 690-699.

`apps/os2/src/durable-objects/project-mcp-server-connection.ts`

- `run_code` emits a lifecycle event, starts codemode execution, then waits for a matching `script-execution-completed` event from the stream. See lines 223-263.
- If a completed event contains an error, the MCP response text is `Error: ...` and `isError: true`. See lines 265-276.
- `waitForScriptExecutionFinished()` streams events with `AbortSignal.timeout(60_000)` and throws if no completed event is observed. See lines 639-685.
- Lifecycle events themselves append to the same session stream through `StreamCapability.append`. See lines 386-406.

`apps/os2/src/entry.workerd.ts`

- `os2-preview-2` exports `CodemodeSession`, `ProjectMcpServerConnection`, `StreamCapability`, and `StreamDurableObject` from the same worker entry. See lines 32-52.
- The temporary `/__debug/append-chain` endpoint deliberately configures a callable subscription and appends a trigger event. See lines 127-220. Older traces from this endpoint are useful proof of the mechanism but are polluted by debug polling/status traffic, so I did not use them as the primary MCP evidence.

## Trace smoking guns

For trace `c63600045bb5494acdb067609b401c93`, Cloudflare shows:

- root `POST https://mcp__test.iterate-preview-2.app/`, status 200, duration 905 ms
- `durable_object_subrequest`: 58 spans
- `jsrpc`: 58 spans
- `StreamDurableObject.append`: 19 spans
- `CodemodeSession.afterAppend`: 7 spans
- one long nested `POST https://loopback-service.local/` at `ProjectMcpServerEntrypoint`, duration 31,901 ms, ending `Network connection lost.`

Longest chain excerpt from that trace:

```text
POST mcp__test
ProjectIngressEntrypoint POST loopback-service.local
ProjectDurableObject.ingressFetch
ProjectMcpServerEntrypoint POST loopback-service.local
ProjectMcpServerConnection GET loopback-service.local
CodemodeSession.startScriptExecution
StreamDurableObject.append
CodemodeSession.afterAppend
StreamDurableObject.append
CodemodeSession.afterAppend
StreamDurableObject.append
CodemodeSession.afterAppend
StreamDurableObject.append
CodemodeSession.afterAppend
StreamDurableObject.append
CodemodeSession.afterAppend
StreamDurableObject.append
CodemodeSession.afterAppend
```

For trace `0602ded79b0fc1ac03e520a16b0e58f8`, Cloudflare shows:

- root `POST https://mcp__test.iterate-preview-2.app/`, status 200, duration 840 ms
- 66 `durable_object_subrequest` spans
- 69 `jsrpc` spans
- 22 `StreamDurableObject.append` spans
- 7 `CodemodeSession.afterAppend` spans
- one nested `ProjectMcpServerEntrypoint` loopback POST lasting 78,122 ms and ending `Network connection lost.`
- two `CodemodeSession.afterAppend` spans lasting about 29-30 seconds.

The traces do not show the literal `Subrequest depth limit exceeded` string in Workers Observability logs. That is expected if the error is caught inside the codemode execution path, serialized into a stream event, and then returned by MCP as normal response text.

## Why callers see either depth exceeded or timeout

There are two different failure surfaces:

1. The subrequest-depth exception happens while codemode is still able to append `script-execution-completed`. In that case `waitForScriptExecutionFinished()` reads the completed event, `run_code` builds an MCP tool response with `Error: Subrequest depth limit exceeded...`, and the caller sees an ordinary MCP text result with `isError: true`.

2. The recursive append/subscriber work gets far enough to stall or lose the nested MCP/loopback connection before the matching `script-execution-completed` event reaches the waiter. In that case the caller is still waiting on `waitForScriptExecutionFinished()`'s stream. The code has a 60 second abort, and Cloudflare traces show nested loopback POSTs losing the network connection after roughly 31s and 78s. That presents as timeout/disconnect rather than a clean codemode error event.

The important detail is that `StreamDurableObject.append()` returns after scheduling async afterAppend work, while the MCP tool waits later on stream output. That split lets the same root call look successful in Cloudflare (`POST ... status 200`) while the durable afterAppend chain keeps consuming subrequests and eventually fails or times out.

## Conclusion

The smoking gun is the repeated `StreamDurableObject.append` plus `CodemodeSession.afterAppend` sequence in real inbound MCP traces, absent from the shallow `providerLimit:0`-style success trace. The source code provides the causal chain: stream afterAppend fanout dispatches callable subscribers, the callable subscriber invokes `CodemodeSession.afterAppend`, and codemode processing appends derived events back to the same stream.

The likely fix direction is to break the synchronous subrequest lineage between stream append fanout and codemode consumption, for example by moving callable subscriber delivery or codemode afterAppend processing behind an alarm/queue/outbox boundary rather than invoking the subscriber RPC directly from the append afterAppend path.
