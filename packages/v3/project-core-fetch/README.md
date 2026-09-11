# Fetch-first project-core fork

This is an intentionally bounded architectural fork beside the clean-room
worker. It asks one narrow question: can the project core be expressed as one
portable `fetch(Request) → Response` object with only three durable verbs?

It can express a useful small core:

| URL                                   | verb   | effect                                                    |
| ------------------------------------- | ------ | --------------------------------------------------------- |
| `/contexts/%2Fdemo/append`            | `POST` | append one event or an event batch                        |
| `/contexts/%2Fdemo/read?after=1`      | `GET`  | read the ordered tail                                     |
| `/contexts/%2Fdemo/subscribe?after=1` | `GET`  | consume the live tail as SSE                              |
| `/contexts/%2Fdemo/fetch/hello`       | any    | dispatch to the newest matching `worker/configured` event |

The context is one URL-encoded path segment, so `"/agents/alice"` becomes
`%2Fagents%2Falice`. `worker/configured` is ordinary log data with `{ route,
source }`; the Node adapter evaluates the source only to demonstrate the
shape. A runtime can instead materialize a pre-built module from the event.

Run the deployed-compatible HTTP proof (it starts a real Node HTTP server and
uses HTTP clients; it does not call core methods directly):

```sh
pnpm --dir packages/v3/project-core-fetch e2e
```

It proves append, ordered read, a live SSE message after subscription, and
dispatch selected from an appended worker configuration event.

## What this fork establishes

The portable core is 127 raw source lines in `src/core.mjs`; the Node-only host
adapter and source runner are 40 lines. Both use platform `Request`, `Response`, and
`ReadableStream` at the seam, so the core can be hosted by Node, a Worker, or
another Fetch-compatible runtime. The store is in-memory on purpose: durable
storage, atomic multi-context batches, replay checkpoints, and retention are
runtime policies that would obscure the fetch experiment.

Fetch also preserves a valuable property from the clean room: a handler gets
the original request and returns the original response object. A Worker host
can carry a WebSocket upgrade across that native fetch chain; neither this Node
adapter nor the e2e proof exercises upgrades.

## Where fetch-first loses semantics

This is not a replacement for the clean-room capability host.

- A URL names an HTTP resource; it does not carry an arbitrary object
  capability, object identity, revocation semantics, promise pipelining, or a
  callback that the server can invoke later. Recreating those needs a
  bidirectional session protocol such as Cap'n Web over WebSocket.
- SSE is server-to-client only. It has no durable acknowledgement, delivery
  cursor, reconnect protocol, bounded retry policy, or callback return value.
  A client can resume with `after`, but correctness policy is absent here.
- HTTP request signatures are portable to Web Crypto, but signer identity,
  key rotation/distribution, canonical serialization, authorization policy,
  and durable verification outcomes are separate concepts. This fork neither
  signs nor verifies events, so it cannot support the proposed signed-event
  platform invariant yet.
- Dynamic source is the decisive portability break: `new Function` works in
  this Node demonstration but is forbidden in Cloudflare Workers. Event-sourced
  configuration is portable; arbitrary source execution requires a build or
  loader service with an explicit trust boundary.
- Egress/ingress rule ordering, secrets, approval holds, auth, repositories,
  and project configuration workers all need more events and durable reducers.
  They are deliberately outside this experiment.

The result is a useful tutorial chapter and a concrete baseline, not evidence
that the full brief can be compressed into this API. Its most important result
is the seam: `append/read/subscribe` fit fetch cleanly; callbacks and arbitrary
capabilities do not without restoring a session-capability layer.
