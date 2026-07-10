# Project Agent Notes

This private repo is the durable brain for the project's agents.

Agents should keep useful, stable project knowledge here: user preferences,
working agreements, product decisions, research summaries, unresolved questions,
and implementation notes that future agents should inherit. Prefer concise
markdown files that are easy to scan and update. Commit changes with
`itx.repo.commitFiles({ message, changes: [{ path, content }] })`.

The whole project worker lives in `worker.ts` (TypeScript) — one file on
purpose, so reading it is reading the whole system. Its default export handles
HTTP for the project's hosts, receives every committed event on every stream
in the project through `processEvent(event)` (checkpointed, at-least-once,
per-stream order — `event.path` says which stream), and reaches the project's
capabilities through `await this.env.ITX.get()`. The worker is built by the
platform's worker build pipeline: multi-file TypeScript works (the bundler
follows imports), and npm dependencies declared in `package.json` are
installed at build time. The platform's capability types come from the
`iterate` package — `import type { Project, StreamEvent } from "iterate/sdk"`.
It's a devDependency here (worker code only imports types from it); run
`npm install` to get typechecking and editor support.

The example apps are named exports of the same `worker.ts`, routed by the
default export's `fetch`: `HelloApp` (stateless WorkerEntrypoint) and
`CounterApp` (a stateful Durable Object serving a mini client-side app whose
count updates live over a WebSocket at `/ws`).
The router dispatches every app request through `this.env.ITX.fetch(...)`
with the app's ref in the `x-iterate-worker-dispatch` header — the platform's
fetch-native worker lane. Keep that shape: it is what lets WebSocket upgrades
and streaming responses tunnel through (an `app.fetch(req)` RPC method call
cannot carry a socket). When an app outgrows the shared file, move its class
into its own module and point the ref's `entryPoint` at it.

An app's HTTP handler MUST literally be a method named `fetch` on the
exported class (a stateless `WorkerEntrypoint` or a stateful `DurableObject`)
— that is Cloudflare's rule, not the platform's: workerd only performs
protocol work, WebSocket upgrades included, through that distinguished
handler on a real worker object. A method named anything else — or a `fetch`
reached as a capability method call — is ordinary RPC: its arguments and
results are serialized copies, so it can serve data but never a socket.
`CounterApp`'s `/ws` route is the seeded WebSocket proof-of-concept; copy its
shape for anything real-time. Method calls on apps
(`project.workers.get(ref).someMethod()`) still use RPC dispatch — only HTTP
rides the fetch lane.

To give agents a new capability surface, add a getter or method to the
default-export worker class: the platform dispatches dotted
`itx.worker.<path>` calls as one flattened `invokeCapability({ path, args })`
that the worker walks in userland, so a getter can hand back a whole vendor
SDK (installed from `package.json`) in a single round trip. Built-in
integrations (Slack, Gmail, GitHub, Telegram, Waitrose) already live at
`itx.integrations.<slug>["<connection>"]` — reach for a worker getter when
the platform has no built-in for a provider.
