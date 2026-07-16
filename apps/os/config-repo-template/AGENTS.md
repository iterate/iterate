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
the project's capabilities through `await this.env.ITX.get()`. Small local
modules are fine when logic deserves focused tests; the seeded GitHub review
contract and `StreamProcessor` live in `github-reviews.ts`, while its
`createStreamProcessorRegistry` Durable Object, repository scope, and labels stay
obvious in `worker.ts`. Review rules are typed data in `worker.ts` too, so each
finding can carry a stable rule ID and file scope. The processor is attached
to the canonical `/agents/repos/g~<sha256>/pull-requests/<number>` stream with
a wake-mode subscription; that one stream is its journal, checkpoint source,
and persistent agent conversation. The worker is built by the
platform's worker build pipeline: multi-file TypeScript works (the bundler
follows imports), and npm dependencies declared in `package.json` are
installed at build time. The platform's capability types and worker base
classes come from the `iterate` package — `import { IterateWorkerEntrypoint,
IterateDurableObject, StreamProcessor, createStreamProcessorRegistry } from
"iterate/sdk"`. It's a
devDependency here: the platform supplies `iterate/sdk` to every worker build
as a virtual module, so the build never installs it; run `npm install` to get
typechecking and editor support.

Every worker class — the root project worker AND the apps — extends one of
the two sdk base classes: `IterateWorkerEntrypoint` (stateless) or
`IterateDurableObject` (stateful). Both carry the same platform surface:
`processEventBatch` unpacks delivered event batches into overrideable
`processEvent(event)` calls, `invokeCapability` dispatches flattened
`itx.worker.<path>` calls (see below), and `fetchDynamicWorker` forwards HTTP
into sibling workers. Env defaults to `{ ITX: ItxBinding }`.

Project-defined stream processors use the same three pieces as built-ins:
`defineProcessorContract(...)`, a class extending `StreamProcessor`, and a
stateful worker class that registers it with `createStreamProcessorRegistry`
and exposes `wakeStreamSubscriber`. The GitHub review processor is the seeded
copyable example. Its consequential work is blocking, so it needs no recovery
alarm; processors with consequential background work must enable registry
recovery and forward `alarm`. Keep consequential output on the typed `append`
lane so the runtime stamps processor provenance and checkpoints only after
blocking work settles.

The example apps are named exports of the same `worker.ts`, routed by the
default export's `fetch`: `HelloApp` (stateless, extends
`IterateWorkerEntrypoint`) and `CounterApp` (stateful, extends
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
rides the fetch lane.

To give agents a new capability surface, add a getter or method to the
default-export worker class: the platform dispatches dotted
`itx.worker.<path>` calls as one flattened `invokeCapability({ path, args })`
that the base class walks in userland, so a getter can hand back a whole
vendor SDK (installed from `package.json`) in a single round trip. Built-in
integrations (Slack, Gmail, GitHub, Telegram, Waitrose) already live at
`itx.integrations.<slug>.get()` (or `.get("<connection>")` when the exact
account matters) — reach for a worker getter when
the platform has no built-in for a provider.
