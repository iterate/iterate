# Draft: `fetch` prelude versus celld egress confinement

> **Partial research draft.** Read-only runtime slice for celld v0.4.1,
> [`10cb1303dac710dcb3b557e318e08c855261f68b`](https://github.com/denoland/celld/tree/10cb1303dac710dcb3b557e318e08c855261f68b).

## Answer

A source prelude that replaces `globalThis.fetch` can make **cooperative,
HTTP-only** loaded code route through an application wrapper. It is not a
replacement for `globalOutbound` confinement or for V4's fetch-door semantics.
It cannot supply the current `env.ITX` bridge in celld, and it does not cover
the runtime's other network APIs. This is a practical migration technique for a
restricted authoring contract, not a transparent compatibility shim.

## What the prelude can do

celld implements ambient HTTP by assigning a normal async function to
`globalThis.fetch`; that function eventually calls `__op_fetch`
([`harness.js:628-689`](https://github.com/denoland/celld/blob/10cb1303dac710dcb3b557e318e08c855261f68b/crates/celld/js/harness.js#L628-L689)). User code can therefore replace the global and route calls that resolve
`fetch` dynamically at call time. A wrapper would have to be async: V4's
`ITX.get()` is an RPC call in the intended design, not a synchronous fetcher
factory.

But current celld passes only JSON loader `env`, explicitly not capability
stubs ([`js.rs:8599-8604`](https://github.com/denoland/celld/blob/10cb1303dac710dcb3b557e318e08c855261f68b/crates/celld/js.rs#L8599-L8604)); bootstrap applies it with `Object.assign(e, JSON)`
([`bootstrap.rs:621-625`](https://github.com/denoland/celld/blob/10cb1303dac710dcb3b557e318e08c855261f68b/crates/celld/js/bootstrap.rs#L621-L625)). Thus the proposed `env.ITX.get().fetch` value cannot be
provided to a loaded worker today.

## Bypasses / missing semantics

- **WebSocket constructor:** `new WebSocket("wss:…")` directly invokes
  `__ws_connect`, not `globalThis.fetch`
  ([`harness.js:10202-10314`](https://github.com/denoland/celld/blob/10cb1303dac710dcb3b557e318e08c855261f68b/crates/celld/js/harness.js#L10202-L10314)).
- **WebSocket upgrade through ambient fetch:** celld's original fetch detects
  `Upgrade: websocket` and calls a distinct `__fetchWebSocketUpgrade`, which
  invokes `__ws_upgrade` ([`harness.js:628-638`](https://github.com/denoland/celld/blob/10cb1303dac710dcb3b557e318e08c855261f68b/crates/celld/js/harness.js#L628-L638),
  [`harness.js:690-734`](https://github.com/denoland/celld/blob/10cb1303dac710dcb3b557e318e08c855261f68b/crates/celld/js/harness.js#L690-L734)). A fetch wrapper can choose to proxy that form, but cannot reproduce a live
  socket merely by returning ordinary HTTP over current flat RPC.
- **TCP:** `import { connect } from "cloudflare:sockets"` binds to
  `globalThis.__cfSockets` ([`modules.rs:667-673`](https://github.com/denoland/celld/blob/10cb1303dac710dcb3b557e318e08c855261f68b/crates/celld/js/modules.rs#L667-L673)); its `connect` calls `__tcp_connect`
  ([`sockets.js:213-230`](https://github.com/denoland/celld/blob/10cb1303dac710dcb3b557e318e08c855261f68b/crates/celld/js/sockets.js#L213-L230)), whose host implementation opens a `tokio::net::TcpStream`
  ([`tcp.rs:131-167`](https://github.com/denoland/celld/blob/10cb1303dac710dcb3b557e318e08c855261f68b/crates/celld/js/tcp.rs#L131-L167)). Replacing `fetch` does not mediate it.
- **Evaluation/captured references:** celld installs its platform prelude and
  harness before evaluating the loaded worker's entry module
  ([`js.rs:7140-7159`](https://github.com/denoland/celld/blob/10cb1303dac710dcb3b557e318e08c855261f68b/crates/celld/js.rs#L7140-L7159)). A user-source assignment in `cap.js` happens during entry-module evaluation,
  not as a privileged host prelude. Static dependencies evaluate before their
  importing module's body, so an imported dependency can capture the original
  `fetch` before that assignment. The existing V4 source interface accepts
  arbitrary module records with `cap.js` as the main module
  ([`worker-loader.ts:361-380`](../packages/v4/project-worker/src/context/worker-loader.ts#L361-L380)); it does not establish a trusted, pre-dependency injection boundary.

## Enforced alternative and current gap

`globalOutbound: null` is useful as the enforcement half: celld sets loaded
egress to `Deny` for `null` ([`js.rs:8617-8628`](https://github.com/denoland/celld/blob/10cb1303dac710dcb3b557e318e08c855261f68b/crates/celld/js.rs#L8617-L8628)), and both ambient fetch and TCP fail under that state
([`js.rs:9308-9316`](https://github.com/denoland/celld/blob/10cb1303dac710dcb3b557e318e08c855261f68b/crates/celld/js.rs#L9308-L9316),
[`tcp.rs:131-141`](https://github.com/denoland/celld/blob/10cb1303dac710dcb3b557e318e08c855261f68b/crates/celld/js/tcp.rs#L131-L141)). An explicit privileged parent broker plus a narrow child bridge is therefore
architecturally sound.

It is not implementable with current loader capabilities alone. The exposed
loader transport is parent-to-child `getEntrypoint().fetch` / one flat RPC method
([`harness.js:2697-2818`](https://github.com/denoland/celld/blob/10cb1303dac710dcb3b557e318e08c855261f68b/crates/celld/js/harness.js#L2697-L2818)); its Rust RPC operation dispatches a method *to* the loaded
worker ([`js.rs:8823-8863`](https://github.com/denoland/celld/blob/10cb1303dac710dcb3b557e318e08c855261f68b/crates/celld/js.rs#L8823-L8863)). There is no child-to-parent service/capability binding or message channel,
and capabilities cannot be injected in `env`.

So a viable future design needs a runtime-supported child→parent bridge (with
request cancellation, byte streaming/backpressure, and WebSocket lifecycle if
V4 fetch-door parity is required), while retaining `globalOutbound: null` as the
native escape-prevention boundary. A JSON/flat-RPC request-response bridge could
cover buffered cooperative HTTP first; it cannot transparently cover streaming
responses, callbacks, or WebSockets under the present transport.
