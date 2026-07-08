# Project Agent Notes

This private repo is the durable brain for the project's agents.

Agents should keep useful, stable project knowledge here: user preferences,
working agreements, product decisions, research summaries, unresolved questions,
and implementation notes that future agents should inherit. Prefer concise
markdown files that are easy to scan and update. Commit changes with
`itx.repo.commitFiles({ message, changes: [{ path, content }] })`.

The project worker entrypoint is `worker.ts` (TypeScript). Its default export
handles HTTP for the project's hosts, receives every committed project event
through `processEvent({ event })`, and reaches the project's capabilities
through `await this.env.ITX.get()`. The worker is built by the platform's
worker build pipeline: multi-file TypeScript works, and npm dependencies
declared in `package.json` (like `@slack/web-api`) are installed at build time.
`sdk.ts` is a snapshot of the platform's capability types (the future
`@iterate-com/sdk` package) taken when this repo was seeded — import types
from it, treat it as read-only.

Apps live under `apps/` as their own dynamic workers, routed by the APPS map
in the root `worker.ts`. The router dispatches every app request through
`this.env.ITX.fetch(...)` with the app's ref in the
`x-iterate-worker-dispatch` header — the platform's fetch-native worker lane.
Keep that shape: it is what lets WebSocket upgrades and streaming responses
tunnel through (an `app.fetch(req)` RPC method call cannot carry a socket).

An app's HTTP handler MUST literally be a method named `fetch` on the
exported class (a stateless `WorkerEntrypoint` or a stateful `DurableObject`)
— that is Cloudflare's rule, not the platform's: workerd only performs
protocol work, WebSocket upgrades included, through that distinguished
handler on a real worker object. A method named anything else — or a `fetch`
reached as a capability method call — is ordinary RPC: its arguments and
results are serialized copies, so it can serve data but never a socket.
`apps/websocket/` is the seeded WebSocket proof-of-concept: a stateful
Durable Object app serving live sockets at `/ws`; copy its shape for anything
real-time. Method calls on apps (`project.workers.get(ref).someMethod()`)
still use RPC dispatch — only HTTP rides the fetch lane.

The worker also exposes a Slack Web API surface backed by the real Slack SDK:
`itx.worker.slack.chat.postMessage({ channel, text })` (any nested Web API
method works). Configure it by committing `slack.config.ts`.

`integrations/waitrose/` is the reference project-owned integration: a
vendored client exposed through this worker's `waitrose` getter —
`itx.worker.waitrose.<connection>.<method>(...)` — durable by construction,
no mount step. Its README.md documents the connection-secret recipe; copy the
pattern (one client file + one getter) for any provider the platform has no
built-in for.
