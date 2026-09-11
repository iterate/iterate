# Cap'n Web as a celld isolate-to-isolate transport

Status: investigated 2026-09-08. This is a design constraint note, not an
implementation or a claim that the candidate transports work in celld.

## Short answer

**Cap'n Web can replace the _RPC protocol_ used between V4 components. It
cannot manufacture the connection or binding which two celld isolates need in
order to speak.**

It supplies exactly the semantics V4 wants once there is a bidirectional
transport: pass-by-reference `RpcTarget`s and functions (including callbacks),
promise pipelining, explicit stub lifetime/disposal, and multiplexed streams.
The transport can be a WebSocket or application-provided `RpcTransport`; it
does not need Workers RPC.

The celld limitation is therefore narrower than “no bindings”: its released
release has ordinary configuration bindings and service/DO fetch routes, but
does not supply the dynamic loaded-worker capability binding V4 currently calls
`env.ITX`. Its cross-isolate native-RPC stubs also do not transfer. Those are
the two things a Cap'n Web design must avoid relying on.
([Supported ordinary bindings](https://github.com/denoland/celld/blob/10cb1303dac710dcb3b557e318e08c855261f68b/docs/cloudflare-compat.md#L305),
[loaded workers receive empty binding lists plus JSON env](https://github.com/denoland/celld/blob/10cb1303dac710dcb3b557e318e08c855261f68b/crates/celld/js.rs#L8599))

## What Cap'n Web provides

The primary API is intentionally transport-independent. `RpcTransport` is a
bidirectional message stream with `send()`, `receive()` and optional `abort()`;
an `RpcSession` exposes one local main object and returns the remote main stub.
See [the interface](https://github.com/iterate/capnweb/blob/ca3da33615370fb66c240a354df40ae39a399822/src/rpc.ts#L13-L48)
and [the public constructor](https://github.com/iterate/capnweb/blob/ca3da33615370fb66c240a354df40ae39a399822/src/index.ts#L67-L87).

That session protocol does support the important V4 behavior:

- A function or `RpcTarget` is sent by reference; calling its received stub
  calls back to its origin. Thus callbacks do not require Workers RPC.
  [README](https://github.com/iterate/capnweb/blob/ca3da33615370fb66c240a354df40ae39a399822/README.md#L251-L275)
- `RpcPromise` supports pipelined property accesses/calls before awaiting the
  earlier result. [README](https://github.com/iterate/capnweb/blob/ca3da33615370fb66c240a354df40ae39a399822/README.md#L279-L303)
- Its ownership model is explicit. A retained callback must be `.dup()`ed and
  released; failure/disconnect breaks outstanding stubs. This is workable, but
  it becomes part of V4's lifecycle contract rather than being implicit in a
  native binding. [README](https://github.com/iterate/capnweb/blob/ca3da33615370fb66c240a354df40ae39a399822/README.md#L484-L536)
- `ReadableStream` and `WritableStream` cross an established session with
  multiplexing and backpressure. They are not a substitute for establishing
  that session. [README](https://github.com/iterate/capnweb/blob/ca3da33615370fb66c240a354df40ae39a399822/README.md#L343-L345)

## The transport choices are not equivalent

| Shape                 | What it can do                                                                                                                                                                                                                     | Crucial limit                                                                                                                                                                                                                                                                                                                 |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HTTP batch            | One client-initiated POST can pipeline a call chain and return values.                                                                                                                                                             | It is not a persistent bidirectional session. The server must not await a call back to the client; the implementation documents that such a call can hang. No retained callbacks/live capabilities. [Implementation](https://github.com/iterate/capnweb/blob/ca3da33615370fb66c240a354df40ae39a399822/src/batch.ts#L145-L178) |
| WebSocket             | A long-lived duplex session: calls at any later time, callbacks and streams all work. Disposing the root closes it. [README](https://github.com/iterate/capnweb/blob/ca3da33615370fb66c240a354df40ae39a399822/README.md#L600-L635) | Requires a real WebSocket connection and careful auth/lifetime limits. A websocket URL alone is authority only if the server treats its token as such.                                                                                                                                                                        |
| Custom `RpcTransport` | Any already-established duplex message channel can carry the whole protocol.                                                                                                                                                       | celld still has to expose or route that channel. `postMessage`/`MessagePort` would be fine in principle, but current celld has not exposed one between the isolates.                                                                                                                                                          |

## What this means for V4 on current celld

V4 already uses both Cap'n Web connection shapes for a _reachable itx fetch
capability_: [the connector](../packages/v4/project-worker/src/library/capnweb.ts)
opens a WebSocket via `itx.fetch`, or implements Cap'n Web's one-shot batch
transport over that fetch capability. That is the right division of labor.

For **loaded code**, do not assume the outer worker can call the loaded worker's
`fetch()` with an upgrade request and receive a connected WebSocket. Current
celld's loader fetch path serializes that response without its WebSocket target.
See [the response encoder call](https://github.com/denoland/celld/blob/10cb1303dac710dcb3b557e318e08c855261f68b/crates/celld/js.rs#L8771).
This is a
separate limitation from Cap'n Web; a Cap'n Web websocket tunnel cannot repair
a socket that celld did not transfer.

The credible no-native-RPC design is instead:

1. The loader gives the loaded worker only plain data: a tightly scoped,
   short-lived URL/token (and perhaps project/context identity), never an ITX
   object/capability.
2. The loaded worker **initiates** its own authenticated WebSocket to a V4
   Cap'n-Web endpoint and receives an explicitly scoped root target. It can
   then use callbacks, pipelining, and streams inside that session.
3. The endpoint enforces the authority, connection count, expiry, revocation,
   per-call limits and explicit disposal. It does not trust an arbitrary
   `context` parameter supplied by code.

Step 2 needs an outbound network facility (ambient outbound fetch, or celld's
future brokered/global outbound feature). It cannot run today under a fully
confined loader with neither `env.ITX` nor outbound access. If that feature
arrives, Cap'n Web becomes a plausible replacement for _native Workers RPC_;
it does not remove the need for a deliberate capability-admission boundary.
Ambient network access already exists when allowed by policy; we need not wait
for Workers RPC to test this with trusted local code. That does not justify
opening ambient egress for untrusted code. The current runtime also enforces
the deny policy on [outbound WebSocket connection attempts](https://github.com/denoland/celld/blob/10cb1303dac710dcb3b557e318e08c855261f68b/crates/celld/js/websocket.rs#L1202).

V4's current `/api` already speaks Cap'n Web, but
[`worker.ts`](../packages/v4/project-worker/src/worker.ts) deliberately terminates
it in the stateless worker and uses Workers RPC to reach the context DO.
[`rpc-stub-relay.ts`](../packages/v4/project-worker/src/context/rpc-stub-relay.ts)
also wraps client capabilities in native Workers RPC targets. A Cap'n Web
adapter must replace those internal native-capability hops as well; adding a
new client to the unchanged public `/api` will still hit them. The intended
seam is the capability transport, preserving the public ITX interface where
possible, not a second implementation of stream/storage/business behavior.

The only lower-level alternative worth exploring is an in-process custom
`RpcTransport` layered on a celld-supported flat method/fetch path. It would
need a tested duplex queue, request correlation, bounded buffering,
cancellation and lifecycle cleanup. That is protocol work, not a simple
`fetch = env.ITX.get().fetch` assignment, and it has not been demonstrated on
celld.

## Security and operational caveats

For WebSocket sessions, Cap'n Web warns that browser WebSocket connections do
not carry arbitrary auth headers, recommends in-band authentication, and calls
out pipelining's potential to queue excessive server work. The V4 endpoint
would need its own rate/capability limits even though Cap'n Web has message
limits. [Security notes](https://github.com/iterate/capnweb/blob/ca3da33615370fb66c240a354df40ae39a399822/README.md#L538-L545)

Do not use HTTP batch where a processor needs delivery after the initiating
request, a held callback, a live state subscription, or reverse calls. It is
a useful stateless control-plane lane, not a replacement for a live ITX
connection.
