# Codemode / MCP Subrequest Depth Findings

Date: 2026-05-06

## Reproduction Loops

### Isolated append-chain endpoint

Endpoint:

`GET https://os2.iterate-preview-2.com/__debug/append-chain`

Modes:

- `mode=sync`: callable subscriber appends the next event directly from its `afterAppend` RPC.
- `mode=alarm`: callable subscriber stores the next event and appends it from a Durable Object alarm.

Observed results:

- `mode=sync&max=7`: completed 7 ticks.
- `mode=sync&max=8`: completed 8 ticks.
- `mode=sync&max=9`: stalled at exactly 8 ticks.
- `mode=alarm&max=20`: completed 20 ticks.

This isolates the failure to synchronous `append -> callable subscriber afterAppend -> append`
lineage. Moving the next append behind an alarm breaks the Cloudflare subrequest lineage.

Useful traces:

- `dc48c92f2abee4999720d8cdb6f9f1b0`: sync chain, 171 spans, max trace depth 36, 15 `StreamDurableObject.append`, 7 `DebugAppendChainSubscriber.afterAppend`.
- `2c2fee02a257e7e1e12e1d7a987a0d8a`: separate status request, shallow, 7 spans.
- `055cdcbcd3e9fd14c44767a6452786f3`: alarm path, shallower per request, includes alarm/storage work and continues successfully.

### Inbound MCP

Endpoint:

`https://mcp__test.iterate-preview-2.app/`

Results:

- `run_code({ code: "/* providerLimit:0 */ async () => 1 + 1" })`: returns `Result: 2`.
- `run_code({ code: "/* providerLimit:1 */ async () => 1 + 1" })`: MCP SDK hit its 60s request timeout.
- `run_code({ code: "async () => 1 + 1" })`: returned `Subrequest depth limit exceeded...` in 7.9s on a fresh run.

Useful traces:

- `13ce0186bd1394e1058a5e13a8cde9e2`: fresh full-provider run, 222 spans, 18 `StreamDurableObject.append`, 7 `CodemodeSession.afterAppend`, plus a 60s `StreamCapability.stream` span.
- `c63600045bb5494acdb067609b401c93`: inbound MCP trace with repeated `StreamDurableObject.append -> CodemodeSession.afterAppend`.
- `0602ded79b0fc1ac03e520a16b0e58f8`: same pattern, includes long nested spans and `Network connection lost`.

## Causal Chain

The stream DO appends an event, updates reduced state, and then calls `afterAppend(event)`.
`afterAppend` runs built-in processors. The external-subscriber processor publishes to callable
subscribers by directly dispatching their RPC callable.

For codemode sessions, the callable subscriber targets `CodemodeSession.afterAppend`. That method
reduces the event with the codemode processor. The codemode processor may append derived events
back to the same stream, including:

- `events.iterate.com/codemode/session-started`
- `events.iterate.com/codemode/script-execution-completed`
- `events.iterate.com/codemode/function-call-requested`
- `events.iterate.com/codemode/function-call-completed`
- `events.iterate.com/codemode/log-emitted`

Those derived appends trigger stream `afterAppend` again, which calls the callable subscriber again.
That creates this Cloudflare RPC/subrequest lineage:

`StreamDurableObject.append -> external subscriber callable -> CodemodeSession.afterAppend -> StreamDurableObject.append -> ...`

## Why Depth Error vs Timeout

These are two surfaces of the same underlying chain.

When the depth exception happens inside code execution and the codemode processor still gets far
enough to append `script-execution-completed`, MCP receives a normal tool result with
`isError: true` and the serialized depth-limit message.

When the recursive subscriber work is running in the background or loses the nested connection
before a matching `script-execution-completed` event reaches the waiter, the MCP request is left
waiting on `StreamCapability.stream` / `waitForScriptExecutionFinished`. Then the observed failure
is a timeout or `Network connection lost`.

The isolated endpoint makes the same split visible: the `start` request can return `200` while the
recursive background chain stalls at 8 ticks. A separate `status` request then proves the chain did
not complete.

## Current Fix Direction

Break callable subscriber delivery out of the append call chain. The isolated alarm mode proves that
an alarm boundary is enough to create a new execution context and avoid accumulating recursive
Cloudflare subrequest depth.

Likely production shape: stream callable subscriptions should be delivered from an alarm/queue/outbox
inside `StreamDurableObject`, not by directly awaiting `dispatchCallable` from append `afterAppend`.
