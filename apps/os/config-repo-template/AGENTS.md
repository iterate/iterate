# Project Agent Notes

This private repo is the durable brain for the project's agents.

Agents should keep useful, stable project knowledge here: user preferences,
working agreements, product decisions, research summaries, unresolved questions,
and implementation notes that future agents should inherit. Prefer concise
markdown files that are easy to scan and update. Commit changes with
`itx.repo.commitFiles({ message, changes: [{ path, content }] })`.

The project worker entrypoint is `worker.ts` (TypeScript). Its default export
handles HTTP for the project's hosts, receives every committed event on every
stream in the project through `processEvent(event)` (checkpointed,
at-least-once, per-stream order — `event.path` says which stream), and reaches
the project's capabilities through `await this.env.ITX.get()`. The seeded
GitHub pull-request router and structural-review policy are deliberately
inline in `worker.ts`: it is a complete, copyable userspace example. Extract
local modules only when project-specific logic earns them. The worker is built
by the platform's worker build pipeline: it passes the repo file map and build
options to `@cloudflare/worker-bundler`, which follows local imports and
attempts to install dependencies declared in `package.json`. The platform's
capability types and worker base classes come from the `iterate` package —
`import { IterateWorkerEntrypoint, IterateDurableObject, type StreamEvent } from
"iterate/sdk"`. It's a devDependency here: the platform supplies the runtime
`iterate/*` subpaths and `@iterate-com/capnweb` to ordinary worker builds, so
`npm install` is only for local typechecking and editor support.

The root project worker and its in-file examples extend one of the two SDK
base classes: `IterateWorkerEntrypoint` (stateless) or
`IterateDurableObject` (stateful). Both carry the same platform surface:
`processEventBatch` unpacks delivered event batches into overrideable
`processEvent(event)` calls, `invokeCapability` dispatches flattened
`itx.worker.<path>` calls (see below), and `fetchDynamicWorker` forwards HTTP
into sibling workers. Env defaults to `{ ITX: ItxBinding }`.

The in-file example apps are named exports of the same `worker.ts`, routed by the
default export's `fetch`: `HelloApp` (stateless, extends
`IterateWorkerEntrypoint`), `InternalApp` (stateless, with authenticated HTML
and a Cap'n Web API), and `CounterApp` (stateful, extends
`IterateDurableObject` — a mini client-side app whose count updates live over
a WebSocket at `/ws`).
The router dispatches every app request through `this.fetchDynamicWorker(req,
ref)` — inherited from the base class — which forwards over the platform's
fetch-native worker lane (`env.ITX.fetch` with the app's ref in the
`x-iterate-worker-dispatch` header). Keep that shape: it is what lets
WebSocket upgrades and streaming responses tunnel through (an
`app.fetch(req)` RPC method call cannot carry a socket — the method's
docstring has the full story). When an app outgrows the shared file, move its
class into its own module and point the ref's `entryPoint` at it.

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
rides the fetch lane. App refs use `source.createApp` directly with ordinary
worker-bundler `server` and `client` entry-point options; its repo-aware
`files` option is the only platform adaptation, and file paths reach
worker-bundler unchanged.

`apps/todo` and `apps/guestbook` show the intentionally smallest browser-app
shape: one `server.tsx` Durable Object and one `client.tsx` browser entry per
app. The same worker-bundler call bundles and tree-shakes the server and client
graphs; React is an ordinary root dependency and no URL import is left for the
browser. This is an example, not a platform file-layout rule. The apps
deliberately avoid Vite and framework adapters. Their HTML leaves CSP unset so
the platform can inject the small Iterate status overlay in the corner.

`InternalApp` is the canonical authenticated userspace-app shape: partial-fetch
HTTP auth plus an explicitly authenticated Cap'n Web `/api` that returns an
app-defined, attenuated session. `README.md` explains the complete flow.

To give agents a new capability surface, add a getter or method to the
default-export worker class: the platform dispatches dotted
`itx.worker.<path>` calls as one flattened `invokeCapability({ path, args })`
that the base class walks in userland, so a getter can hand back a whole
platform-supplied SDK surface in a single round trip. Built-in
integrations (Slack, Gmail, GitHub, Telegram, Waitrose) already live at
`itx.integrations.<slug>.get()` (or `.get("<connection>")` when the exact
account matters) — reach for a worker getter when
the platform has no built-in for a provider.
