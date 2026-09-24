# Agent AI streaming and Cloudflare RPC lifetime

On 23 September 2026, production agent replies completed but Cloudflare recorded this exception
on `ItxEntrypoint.get`:

> The Workers runtime canceled this request because it detected that your Worker's code had hung
> and would never generate a response.

HTTP 200 and a complete reply did not establish a healthy request. Verification requires the
provider's SSE text and terminal completion event **and** a Worker tail with no such exceptions.
The ordinary `canceled` RPC outcome after explicit scope disposal is a separate category.

## Minimal deployed reproduction

A standalone Cloudflare Worker, without Iterate code or dynamic Worker loading, reproduced it:

```text
Caller Durable Object
  -> service binding getTarget(), returning a native RpcTarget
    -> target method invokes a second Durable Object
      -> env.AI.run("openai/gpt-6-astra", input, options)
        -> raw Response with SSE body, passed back to the caller
```

The request uses Responses API `input`, `stream: true`, `store: false`, and
`reasoning: { effort: "low", summary: "auto" }`; binding options are
`returnRawResponse: true` and `gateway: { id: "default", skipCache: true }`.
The caller drains the returned body and checks `response.output_text.delta` and
`response.completed`. Both Durable Objects and the outer HTTP request succeed, but the
service's `getTarget` invocation records the exception above.

Run the same request with a verified live Wrangler JSON tail in the deployment's account.
A tail that exited or received no requests is not evidence. Compare these controls:

| Caller / provider                       | Result         | Service getTarget exception |
| --------------------------------------- | -------------- | --------------------------- |
| DO / scalar target                      | Correct scalar | None                        |
| DO / second DO returning scalar         | Correct scalar | None                        |
| DO / direct AI binding                  | Complete SSE   | None                        |
| DO / stateless target calling AI        | Complete SSE   | None                        |
| Stateless Worker / second DO calling AI | Complete SSE   | None                        |
| DO / second DO calling AI               | Complete SSE   | **Hung-request exception**  |

The in-platform reproduction also failed with both foreground and background DO calls, and with
scope disposal before or after draining the body. Stateless callers passed eight real-AI
streaming/nonstreaming and disposal controls. DO callers passed delayed synthetic-response
controls. The runtime's precise internal liveness-bookkeeping defect remains unproven; the
native reproduction establishes that Iterate's application code is not required to trigger it.

## Failed transport experiment

A fixed-source stateless Worker re-entered the original agent path, called its `itx.ai`
capability, and passed the original Response or ReadableStream back to the DO. The agent's
AI overrides and masks remained effective, and real Garple chats completed. However, after
allowing delayed tail events to arrive, both preview and production still recorded the hung
exception. The production experiment was rolled back to the prior installed runtime.

A zero-exception tail snapshot immediately after the chat completed was a false negative.
Always allow the tail to drain and re-check the original event-time window; late-arriving events
retain the invocation's start timestamp. The stateless bridge by itself is not a fix.

The local delayed-stream tests remain useful compatibility controls, but fake providers do not
reproduce the deployed runtime defect and cannot establish that it is resolved.

A TransformStream relay and a returned RPC reader also reproduced the exception after tail
maturation. A minimal push relay passed: the stateless Worker fully consumes provider I/O and
awaits a caller-supplied sink for each copied byte chunk, then returns plain completion data.
Both foreground and background callers received complete SSE output with zero exceptions in
mature telemetry. This preserves streaming and backpressure without transferring provider I/O
to the Durable Object.

## Application transport

[`ai-transport-source.ts`](ai-transport-source.ts) (the stateless relay) and
[`ai-transport.ts`](ai-transport.ts) (the sink) implement that push protocol. The stateless Worker
calls `itx.ai` at the original agent path, preserving its inherited overrides and explicit
capability masks. It forwards response metadata and awaits each byte write into a caller-owned
native `RpcTarget`; the agent Durable Object presents a fresh local stream to the existing
processor. The remote call remains active until provider I/O finishes. No provider Response,
stream, or reader is returned to the Durable Object.

Initial response, individual provider reads, and each sink write have a 45-second timeout.
Interrupting a turn rejects the local body immediately. Cleanup cancellation is best-effort and
is never awaited during error unwinding, so a stalled peer cannot escape that bound. A provider
read already in flight stops when the next sink write observes cancellation or the idle timeout
expires; provider cancellation is bounded, but is not necessarily immediate. Ordinary local
interruption does not become a waitUntil exception.

The processor retains incremental chunk events, final settlement, nonstreaming JSON replies,
provider HTTP errors, and null response bodies. Its SSE decoder only falls back when JSON parsing
fails; errors raised by a decoded provider event propagate and terminate the active transport.
Local regression tests cover partner Response streams, Workers AI ReadableStreams, path-scoped
overrides, explicit masks, in-band provider stream failures, and interruption.
Real-AI verification on the restored Garple preview additionally checks the deployed runtime
defect: a complete public-shaped chat and a tail observed for at least 70 seconds after reply
completion. Fake providers alone cannot prove this transport avoids the Cloudflare exception.

The change is app-owned. Existing projects need the Agents app's normal runtime installation
before their installed processor uses it; changing the platform Worker alone does not upgrade
those projects. The installed agent runtime now uses the project's `workers` capability to load
the fixed transport source, as well as the agent path's `ai` capability.
