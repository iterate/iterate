# itx: what's next (working notes)

Status: NOODLING. This is the running list of things we want to fix or build in
the itx layer, with positions and open questions. Nothing here is committed;
when an item graduates it gets its own task/PR. Companion docs: `apps/os/src/itx/README.md`
(what exists), `apps/os/src/itx/DECISIONS.md` (what changed on contact with
reality).

## 0. The frame (recap, so this doc stands alone)

A **context** is a durable, network-attached JS object: capabilities are its
properties, the parent context is its prototype, and an **itx** is a remote
reference to it. Lookup walks child → parent with shadowing (one DO hop per
miss); writes always land on the node your handle points at; `fork()` is
`Object.create(parent)`.

A handle carries two separate things that must never be conflated (§3):
its **access set** (which refs it may resolve — the authority, checked at
every resolution) and its **default ref components** (which parts of a ref
you may elide — pure ergonomics). "Project context" is not a structural
concept: a project is a domain object with an ID that _happens_ to be
usable as the namespace certain collections (streams, repos, workspaces)
are keyed by. The 99% case, never a kernel assumption.

The dimensions a capability can vary along (these are orthogonal; the current
`live | worker | facet` kinds are three _points_ in this space, not the axes):

1. **Who authored the code** — first-party trusted vs. AI/user-written.
2. **Where it executes** — platform (static worker / dynamic isolate / DO
   facet) vs. outside (Node on a laptop, agent sandbox, browser, phone,
   third-party server).
3. **Stateful vs. stateless.**
4. **Wiring direction**, from the context's perspective — _inbound_
   (something holds a live connection to me; the cap exists because the
   connection exists) vs. _outbound_ (I hold an address and reach out at
   invoke time — a binding, an entrypoint, a URL, or stored source the
   platform materializes into an isolate).
5. **Registration lifetime** — session-bound vs. durable.

`kind` in the registry is really just "how the supervisor obtains a target
stub at invoke time": `live` = take from memory, `worker` =
`loader.getEntrypoint()`, `facet` = `ctx.facets.get()`. Everything below
follows from generalizing that.

## 1. CapTarget: a name and a target, the target comes in kinds

Every gap we keep hitting is the same gap. A capability is a **name plus a
target**, and the target is ONE discriminated union covering every way the
supervisor obtains a callable at invoke time:

```ts
type CapTarget =
  | { type: "live"; stub: LiveStub } // inbound: a connected provider's stub, session-bound. The ONE non-serializable kind.
  | { type: "rpc"; worker: WorkerRef; entrypoint?: string; props?: Record<string, unknown> }
  | { type: "url"; url: string; headers?: Record<string, string> }; // a Cap'n Web server across the internet; headers pass through egress secret substitution

type WorkerRef = // where an rpc target's worker lives — ONE shape for everything Workers-RPC-reachable
  | { type: "binding"; binding: string } // anything on env: a service binding, env.AI, a queue
  | { type: "loopback" } // the platform worker's own exports (first-party code, incl. the ProjectWorker forwarder)
  | { type: "durable-object"; binding: string; name: string }
  | { type: "source"; source: CapSource }; // a dynamic worker materialized from stored source
```

The project worker SHIPPED as the `ProjectWorker` loopback forwarder (no
dedicated union kind — review concluded the earlier sketch was right):
`entrypoint: "ProjectWorker", props: { export: "YourClass", invoke?,
…params }`. The forwarder hands the call to the Project DO, which replays
it against `getEntrypoint(props.export, { props })` on the freshly-built
worker — loader entrypoints cannot cross an RPC boundary, so the call
crosses as data and a push is live on the next invocation. The price of
no-new-kind: the USER's export name and inner invoke mode ride in props,
because the cap's own entrypoint/invoke describe the forwarder hop. The
litmus test below is a live e2e.

(Revised on review from a flat nine-kind union: the Workers-RPC-reachable
kinds — binding, loopback, entrypoint, durable-object, config-worker,
dynamic-worker — were all secretly the same thing, "an RPC target in some
worker", and collapsed into `rpc` × `WorkerRef`. The full per-kind
docstrings live in `apps/os/src/itx/types.ts`, which is the design of
record.)

`durable-object` refs SHIPPED, config-gated: the registry resolves
`{ type: "durable-object", binding, name }` with members/path-call
dispatch like any rpc target, dialing
`env[binding].getByName(`itx:<projectId>:<name>`)` — names are scoped
under the owning project, so an allowlisted namespace's itx-reachable
instances are disjoint per project. The namespace allowlist
(`DIALABLE_DURABLE_OBJECTS`) is still EMPTY by default: namespaces whose
EXISTING instances matter (PROJECT, STREAM, …) must not be allowlisted,
since itx dials would only ever reach fresh/empty objects under the
scoped names. Deployments opt namespaces in via
`APP_CONFIG_ITX.dialableDurableObjects` once they have one designed to
be reached this way.

`url` refs SHIPPED: the registry hands the call as data to the `UrlDial`
loopback entrypoint (`src/itx/caps/url-dial.ts`), which opens ONE
WebSocket Cap'n Web session per call in the stateless worker (Law 7 —
never a DO), replays the cap's invoke mode against the remote main
(members = property pipelining, still one round trip), and disposes.
Handshake headers pass through the same `getSecret()` substitution as
project egress, resolved via the SecretsCapability loopback — so remote
credentials never appear in registry rows. Always a WebSocket session,
never an HTTP batch: `newHttpBatchRpcSession` is banned repo-wide by the
`iterate/no-capnweb-http-batch` lint rule (batch would silently break
pipelining across awaits; stateless workers hold sockets for a request's
duration just fine). Known gap: url dials bypass fetch-cap shadowing
(see New debts).

**Inbound vs. outbound is a derived direction, not API surface.** `live` is
inbound (something holds a connection to me; the cap exists because the
connection exists); `rpc` and `url` are outbound (I reach out at invoke
time). The caller never spells the direction. Storing source and loading it
ourselves is not a third category, just another `WorkerRef` — which is
exactly the two-case shape `borrowTarget` already has (live table, or
resolve-the-target).

**MCP and OpenAPI are deliberately NOT in the union.** They are not
transports — they are client _implementations_, i.e. ordinary RPC targets.
The litmus test for the whole design: a user must be able to implement an
OpenAPI (or MCP) client as a WorkerEntrypoint exported from their own
project worker and register it as a first-class cap — and the
first-party `McpClient` must be the SAME shape — both are loopback
entrypoints; the user-space one goes through the `ProjectWorker` forwarder:

```ts
// First-party MCP client, parameterized per server. Headers carry
// getSecret() placeholders — they travel through project egress.
await itx.caps.define({
  name: "docs",
  invoke: "path-call",
  target: {
    type: "rpc",
    worker: { type: "loopback" },
    entrypoint: "McpClient",
    props: { serverUrl: "https://docs.example.com/mcp", headers: { … } },
  },
});

// User-space OpenAPI client: a class YOU export from your project worker.
await itx.caps.define({
  invoke: "path-call",
  name: "petstore",
  target: {
    type: "rpc",
    worker: { type: "loopback" },
    entrypoint: "ProjectWorker",
    props: {
      export: "OpenApiClient",
      invoke: "path-call",
      specUrl: "https://petstore.example.com/openapi.json",
    },
  },
});
```

If the first-party client needs anything the user-space one can't have, the
design has failed. Build both as the acceptance test (§4).

Prior art in our own codebase: codemode's `ToolProviderRegistration` carries a
`Callable` (`@iterate-com/shared/callable`) with
`via: env-binding | loopback-binding` + `rpcMethod`. That IS this concept,
buried inside codemode. Decision: take inspiration, don't necessarily reuse —
the Callable shape carries codemode-specific baggage (`rpcMethod`,
`argsMode`); CapTarget should stay a pure target description and let the existing
`invoke: "members" | "path-call"` modes describe the calling convention.

### Are these sturdy refs? (yes — here's the receipts)

Kenton's Cap'n Proto defines this exactly, in
[`persistent.capnp`](https://github.com/capnproto/capnproto/blob/master/c%2B%2B/src/capnp/persistent.capnp):
a live capability can `save()` to a **SturdyRef**, a serializable token that
can be stored and later **restored** to a live capability on a future
connection. Crucially:

- "The exact format of SturdyRef depends on the **realm**" — a realm is "an
  abstract space in which all SturdyRefs have the same format and refer to
  the same set of resources." The format is deliberately NOT defined by
  Cap'n Proto; each application defines its own.
- Restoring is itself a capability: per Kenton on the
  [mailing list](https://groups.google.com/g/capnproto/c/d6uPbXf9e4E),
  SturdyRefs are "sort of a design pattern… you can call save() on a
  capability and receive back some sort of token that you can use to get
  that capability again in the future," and the restorer may sit behind
  authentication.
- Refs can be **sealed** to an owner ("so that it can only be restored by
  the specified Owner… meant to mitigate damage when a SturdyRef is
  leaked").
- Cap'n Web itself has none of this today (the README doesn't mention
  persistence at all) — which is fine; it's a realm-level concern.

So: **the iterate platform is a realm; the serializable `CapTarget` kinds
(everything except `live`) are our realm's SturdyRef format; `resolveItx`
is — and is already named — the restorer.** The
vocabulary is already half-adopted: `protocol.ts` calls context ids "sturdy
refs" and `entrypoint.ts` calls `resolveItx` "the restorer." CapTarget
completes the picture by making capability _targets_ sturdy, not just
contexts.

One deliberate divergence to write down: classic SturdyRefs are often bearer
tokens (possession = authority). Ours are **names within a trusted realm** —
they carry zero authority by content (Law 2/3); authority is which context
your handle points at, checked at connect. The one place we DO mint
bearer-style sealed refs is the HTTP share token
(`createShareToken`: HMAC over `project:cap:expiry`) — that is literally a
sealed, expiring SturdyRef for one cap's fetch surface, and we should
document it as such. Position: keep it that way — bearer form exists only at
the HTTP edge, never inside the realm.

### One verb, not three

Earlier draft had `provide` / `dial` / `define` as sibling verbs. Preference:
they're all "register a capability"; make ONE function whose argument shape
is self-documenting:

```ts
itx.caps.define({ name: "mac",   target: stub });                                                          // inbound, session-bound
itx.caps.define({ name: "slack", target: { type: "rpc", worker: { type: "source", source: { … } } } });    // outbound, durable
itx.caps.define({ name: "ai",    target: { type: "rpc", worker: { type: "binding", binding: "AI" } } });   // outbound, durable
```

RESOLVED (supersedes an earlier `target | source | address` triple, which
was confusing): one field, **`target`**, in different kinds. No separate
`source`/`address` arms; direction is derived from the kind, never spelled
by the caller. SHIPPED in the consolidation pass (2026-06-10): there is no
`{ type: "live", stub }` wrapper — the bare stub IS the live form, and the
registry discriminates structurally (plain `type: "rpc" | "url"` data vs
everything else). `caps.provide` stays as a one-line alias.

RESOLVED: `kind: "facet"` dies as user-facing vocabulary (it names the
platform _mechanism_, not the concept, and hides that this is a Durable
Object). A dynamic worker's statefulness is a property of its source — the
entrypoint export is either a `WorkerEntrypoint` (stateless, fresh per
call) or a `DurableObject` class (stateful, own private SQLite; the
platform instantiates it as a DO facet under the hood):

```ts
source: {
  cacheKey, mainModule, modules,
  entrypoint: "Todo",
  exportType: "worker-entrypoint" | "durable-object",
}
```

## 2. Platform bindings as capabilities (env.AI, env.BROWSER, queues, …)

It must be **trivially easy** to hand a Cloudflare binding to a context —
but raw pass-through is the _degenerate_ case, not the common one. Look at
what the codemode AI provider actually does: it doesn't expose `env.AI`
raw — it wraps it a tiny bit (picks a gateway, appends user/attribution
info). That will usually be the case: a binding cap is _almost_
pass-through, plus a thin policy layer (gateway selection, attribution,
later allowlists/quotas).

The pattern is the one we already have — ProjectEgress / Law 5, applied to
a different resource. The platform ships ONE generic first-party loopback
entrypoint (say `BindingCapability`) that receives identity props, applies
policy, and replays the call onto `env[props.binding]`:

```ts
itx.caps.define({
  name: "ai",
  invoke: "members",
  target: {
    type: "rpc",
    worker: { type: "loopback" },
    entrypoint: "BindingCapability",
    props: { binding: "AI", gateway: "project-default" },
    // the registry adds { context, cap } attribution props at dial time,
    // exactly as it does for ProjectEgress today
  },
});
```

Composition stays in code (the one entrypoint), parameterization stays in
props (identity + attribution — Law 2 holds). Raw `{ type: "binding" }`
remains in CapTarget for genuinely pass-through cases, but expect bindings
to arrive wrapped. The supervisor's per-call hook (one line in
`ContextRegistry.invoke`) gives usage/billing events for every cap
uniformly.

Authorization: defining a binding-backed cap requires a handle whose access
covers the resource (global/admin for account-wide bindings like AI and
browser rendering); once defined on a context, any handle on that context
may call it. Open: do wrappers stay one generic `BindingCapability`
entrypoint in practice, or do AI/browser/queues each want a small bespoke
wrapper (gateway logic differs per binding)?

Config-driven allowlists SHIPPED: `APP_CONFIG_ITX`
(`dialableBindings`/`dialableLoopbacks`) merges with the hardcoded
defaults via `resolveDialableTargets` — config can only WIDEN, so a
misconfigured deployment never loses first-party caps. The registry hosts
resolve the merged set once and use it at both define and dial time;
`BindingCapability` applies the same merge as its authoritative gate.

## 3. A real global context (and the addressing model)

Today `global` is fake: `resolveItx("global")` builds a handle with
`projectId: null`, no registry, no node. Make it real. And the right frame
for _what_ an itx is fell out of discussing it:

**An itx is the realm's restorer, partially applied and bounded.** It is
the function `ref → live object`, with some ref components pre-bound (the
handle's _defaults_) and resolution limited to its _access set_. Every
accessor is that one function in different sugar — `projects.get(ref)`,
`streams.get(ref)`, `itx.slack` (a cap name is a context-relative ref),
`fork()` (mint a ref, restore it). Connect is the same function with the
authority supplied differently: `connectItx({ context: "global" },
credential)` is `restore("global")` where the credential determines the
bounds; thereafter the handle's own access set plays that role for every
resolution. `resolveItx` already is this function — it just doesn't know
it's the whole story.

Refs are **unauthenticated** — pure names, zero authority by content.
`"global"` is a ref anyone can write down; what restoring it yields depends
entirely on who is restoring (Kenton: "restoring is itself a capability").
The sealed HTTP share token stays the one deliberate bearer-form exception,
at the edge only.

**Namespaces belong to collections, not to contexts.** Streams, repos, and
workspaces happen to be keyed by `(namespace, id)`; a project's ID happens
to be usable as a namespace; `global` is another namespace value — and it
really exists in production (Slack webhook receiving streams, global repos,
the base iterate-config artifact / base repo). All of these address the
same stream, and all must work:

```ts
// on a global handle:
itx.streams.get("proj_123:/path"); // absolute, string ref
itx.streams.get({ namespace: "proj_123", path: "/path" }); // absolute, structured ref
itx.projects.get("proj_123").streams.get("/path"); // narrow, then relative
itx.projects.get("proj_123").streams.get({ path: "/path" });
// likewise itx.repos.get({ namespace, slug }), namespace may be "global"
```

Three rules keep this honest:

1. **Sugar rule** — absolute forms internally construct the narrowed handle
   and call through (Law 4). ONE code path; the access check never forks.
2. **Resolution checks access** — every restore is checked against the
   handle's access set, with the same error as not-found (no existence
   probing). `projects.get` already behaves this way; this extends the same
   rule to fully-qualified collection refs. A project handle cannot
   fully-qualify its way out: `proj_456:/x` fails against access
   `[proj_123]`.
3. **Defaults ≠ authority** — narrowing produces a handle with a smaller
   access set AND tighter defaults; only the access set is security.

It follows that the global context is NOT a special node: same anatomy as
every other context (registry, audit stream, live table). The spec's old
worry ("ambient authority creep starts here") is handled by _access_, not
by crippling the node. Naming: keep `global`, not `root` — it's already the
literal namespace name in the streams domain.

**The access model is deliberately two-tier, and it shipped (PR #1418):**
admin is the Better Auth admin-plugin role (`user.role === "admin"`,
surfaced to OS as `role` / `is_admin` token claims), while OAuth project
selection remains `project:<id>` scope strings. Admin resolves to access
`"all"`; everyone else may do project-scoped things iff the project id is
literally in their scopes. There is no separate "global namespace grant" —
global authority IS admin. The code keeps ONE seam where finer-grained
permissions would slot in later; we deliberately build none of it now.
#1418 also already ships the first slice of this section: the `/admin` UI
connects to the global itx over Cap'n Web, and `itx.streams`
on a global handle targets the deployment-wide `global` namespace, gated
on access `"all"`.

Direction, not commitment: if every accessor is restore-with-sugar, the
logical endgame is one literal `itx.restore(ref)` taking a self-describing
ref (`"stream:proj_123:/path"`). Today each collection parses its own ref
format and that's fine; write the direction down so the dotted API is
understood as sugar, and build the universal form only when something needs
it.

The addressing slice SHIPPED: `itx.streams.get` takes `"/path"`
(relative), `"ns:/path"`, and `{ namespace?, path }` (absolute). Absolute
forms are sugar — they construct the narrowed collection and call through
(rule 1), so the access check lives in exactly one place
(`ItxStreams.namespace`), now masked as NOT_FOUND like `projects.get`
(rule 2): a project handle cannot fully-qualify its way out, and named
access sets work, not just admin. The global REGISTRY node stays
descoped: `global` still resolves with no registry; nothing needs to
define caps on it yet, and §8 already gives `global` its cheap birth as a
code context when something does.

Remaining questions:

- Is the global context's stream the audit surface for project lifecycle
  (created/deleted), the way project `/itx` streams audit cap lifecycle?
  (Symmetry says yes.)
- Confirm the uncurried `{ namespace, … }` accessor pattern uniformly
  across repos/streams/workspaces (streams done; repos/workspaces open).

## 4. Drop codemode — SHIPPED 2026-06-10 (#1445/#1446/#1447, stateless MCP #1464)

A codemode session is a child context that doesn't know it yet. The
`CodemodeProcessor` reduces `tool-provider-registered` events into a provider
map — that map IS a capability registry maintained in parallel via streams.
The executor's `ctx` proxy IS the itx path-proxy. `callFunction`'s
longest-prefix provider resolution IS registry dispatch.

The plan:

- A session = `itx.extend()` → a child context on a stream path.
- Tool providers = caps on that context. The three codemode provider families
  map exactly onto §1:
  - `itx.ai` → `{ type: "rpc", worker: { type: "binding" | "loopback" } }` (§2),
  - `itx.mcp.*` / `connectToMcpServer` → first-party `McpClient` entrypoint
    via `{ type: "rpc", worker: { type: "loopback" }, props: { serverUrl, headers } }`,
  - OpenAPI providers → user-space `OpenApiClient` exported from the
    project worker, via `{ type: "rpc", worker: { type: "project-worker" } }`.
    Making those three work — one first-party, one user-space, same shape —
    is the acceptance test for CapTarget (the litmus test in §1).
- Execution = two events on the context's stream:
  - `events.iterate.com/itx/execution-requested` `{ executionId, code, vars }`
  - `events.iterate.com/itx/execution-completed` `{ executionId, result | error, durationMs }`
- **Record-only mode first**: the caller appends `execution-requested`, runs
  the existing `/api/itx/run` loader harness inline (env.ITERATE scoped to
  the context), appends `execution-completed`. Events are the durable
  record, not the transport. No processor.
- **Processor mode later** (additive): a subscriber on the context's stream
  picks up `execution-requested` and runs it — durable/disconnected runs
  (Slack-agent style). This is also the streams-convergence proof (§6): the
  processor is just a dialed subscriber.
- Per-function-call events (`function-call-requested/completed`) die. If we
  want call-level audit later it's one hook in `ContextRegistry.invoke` —
  the single supervisor dispatch — covering every cap uniformly.
- `ProjectMcpServerConnection` shrinks to: authenticate → fork-or-reuse a
  child context per MCP session → append/run/await → format (~750 lines →
  ~150).
- Needed along the way: per-context execution streams. Child-context audit
  currently lands on the project's `/itx` stream (D9); execution events want
  the session's history self-contained (e.g. `/itx/ctx_…`). Decide path
  scheme.

### Providing capabilities via events?

The question that came up: "if I wanted to use an execution-requested event
to provide a new capability, I'd have to run a one-off script that calls
`caps.define` with source code in string form — should there be a dedicated
event that lets me write the code unescaped?"

Untangling it:

- Cap definitions are ALREADY durable without any event: `define` writes the
  registry SQLite row; the stream gets an audit event (D1: table
  authoritative, stream is history). You never _need_ an event to provide.
- A script execution that calls `itx.caps.define(...)` works today and is
  the honest general mechanism (code holds composition, Law 1).
- The string-escaping pain is real but it's an _authoring_ problem, not a
  protocol problem. A dedicated `cap-define-requested` event with unescaped
  source in the payload would create a SECOND way to mutate the registry,
  with ordering/authority questions (who may append it? does replaying a
  stream re-define caps?) — that's composition-as-data creeping back in.
- Position: don't add the event. Fix the authoring ergonomics instead:
  the REPL/SDK gets a helper that takes a real function/module, stringifies
  - bundles it, and calls `define` (this is also what "promotion from the
    REPL" already needs). Revisit only if a concrete replay/declarative-setup
    use case shows up.
- Open question to confirm: was the underlying want auditability/replay
  ("rebuild a context from its stream") or just ergonomics? If replay, that
  is a different feature (registry snapshots/event-sourcing) and should be
  argued on its own.

## 5. The handwritten types file

SHIPPED (first cut): `apps/os/src/itx/types.ts` — handwritten, import-free,
narrative-first (the three concepts, a thirty-second worked example, then
the handle, capabilities, streams, projects, wire types). It is
simultaneously: the source of truth the implementation conforms to, the
string fed to the REPL editor for completion, and the document handed to an
agent as "this is what you have."

Decisions made in it on first review:

- `KnownCaps` (not `ProjectCaps`) is the declaration-merge point for typed
  caps — and it is documented as a compile-time convenience GLOBAL to the
  codebase; the runtime truth is always `describe()`.
- No invented access type: `ItxPrincipal` is typed out by hand from
  `~/auth/principal.ts` + `auth-claims` (admin | user with organizations +
  projects), so drift becomes a type error. `ItxProps` carries the
  principal, not a precomputed access list.
- `ContextRef` is a template-literal union
  (`"global" | prj_… | proj_… | ctx_…`), not a bare string.
- `CapMeta` is arbitrary metadata with ONE convention: `instructions`, a
  sentence for the agent who finds the cap, surfaced by `describe()`.
- `describe()` is specified as the always-works, maximum-breadcrumbs
  exploration entry point.
- A context is defined as an _addressable_ node — durability is optional
  (needed only when others must re-address it; the global handle today is a
  context with no node behind it).
- Open: split `GlobalItx` / `ProjectItx` at the type level? Today one `Itx`
  type; project-needing members throw on global handles.
- `codeId` is RENAMED to `cacheKey` — it was never an id ("id" in this
  codebase means typeid); it's the loader's cache key, content hash ideal.
  Implementation migrates when CapSource moves into the kernel.

## 6. Streams convergence (after CapTarget exists)

A stream subscriber registration is — literally, in the code — a `Callable`
the Stream DO dials to deliver events. With CapTarget in place: contexts
and streams share the address/dial/reconnect machinery (one module:
addresses, dialing, dup-discipline, offline semantics); the stream keeps its
delivery semantics (offsets, checkpoints, at-least-once). A subscriber
becomes "a cap this stream dials with a delivery loop."

Whether to merge node types entirely ("every context has a stream; a stream
is a context whose primary fact is its log") is a real possibility but a
second step, taken only after the shared layer proves itself.

## 7. Smaller items

- ~~Rename "iterate-config worker" → "project worker" codebase-wide~~ →
  SHIPPED (PR #1466, DECISIONS D22): it's just **the worker** now —
  `durable-objects/worker.ts`, `callWorkerFunction`, `itx.worker`. Same PR
  also made `project.fetch` = egress, moved ingress dispatch into the
  stateless `ProjectIngressEntrypoint`, and event-sourced project creation
  through the `project` processor (creation-requested → steps → completed —
  the §4-adjacent "domain objects come to be via events" jam, applied to
  projects).
- `handle.ts` sheds its direct domain imports (repos/workspace/streams) —
  they become default caps; mechanism in §8. Kernel approaches the
  ~500-line goal.
- Document the share token as a sealed SturdyRef (§1).
- Per-cap/per-call usage events at the supervisor (billing + audit hook,
  feeds §2 and §4).
- Global-context implementation: make the node real, wire namespace
  currying through the built-ins. (Polishing its shape beyond that is
  explicitly LATER.)

## 8. Default capabilities are parent contexts written in code — SHIPPED (D23)

The idea (born as "what if ProjectItx / GlobalItx / CodemodeSessionItx
subclasses just called `this.caps.define()` a few times in their
constructor, the way you would in a codemode snippet"): now that
`caps.define` exists, the built-ins hardwired into the handle should be
ordinary capability definitions. The instinct is right; the question is
where those definitions live. Per-handle is wrong (handles are ephemeral
views; defines are node writes). Per-node-as-rows works but churns: every
project duplicates identical rows, and shipping a new platform default
means migrating thousands of registries.

The answer needs NO new concept — not "flavors", and not an ItxProps
builder either. A named, addressable, shadowable collection of caps that
lookup falls through to **is what a context is**. The defaults are simply a
parent context that happens to be implemented in code instead of SQLite
rows:

```text
ctx_session → prj_123 → platform:project (code) → global
```

Chain delegation already exists; a hop to a code-defined context resolves
in-process (no DO hop). `describe()` merges it with
`owner: "platform:project"` provenance like any ancestor. Shadowing works
because shadowing already works. Law 1 said it all along: code holds
composition — defaults are composition; only overrides are data.

Why not props (the builder framing): Law 2 — props carry identity, never
composition. "Here are the caps you have" riding in props is
composition-as-data, the exact thing the mounts/scopes deletion killed. And
defaults must resolve server-side at the node anyway: a worker cap calling
`itx.ai` dispatches through its home context's chain regardless of how any
handle was constructed. The builder intuition survives as the _authoring_
surface: what you build is a code context, with the same verbs as a REPL
snippet, executed once per isolate against an in-memory registry:

```ts
export const projectContext = defineCodeContext("platform:project", (caps) => {
  caps.define({
    name: "repos",
    target: { type: "rpc", worker: { type: "loopback" }, entrypoint: "ReposCapability" },
  });
  caps.define({
    name: "workspace",
    target: { type: "rpc", worker: { type: "loopback" }, entrypoint: "WorkspaceCapability" },
  });
  caps.define({
    name: "ai",
    target: {
      type: "rpc",
      worker: { type: "loopback" },
      entrypoint: "BindingCapability",
      props: { binding: "AI" },
    },
  });
  // worker → { type: "project-worker" }; project → { type: "durable-object" } — once those refs land
});
```

(The registry injects `{ context, cap }` attribution at dial time, so code
contexts stay fully static — entrypoints derive the project from context.)

What this dissolves:

- **"Cap #0" disappears.** Every hardwired built-in maps onto an
  already-designed target kind — repos/workspace/streams → loopback,
  ai → binding/loopback, worker → project-worker, project →
  durable-object — strong validation of CapTarget. The irreducible kernel
  shrinks to `caps`, `fork`, `describe`, `fetch` (Law 5 infrastructure),
  plus `projects` on global handles. Reserved names shrink to match;
  defaults become shadowable (prototype semantics — the point).
- **The global context gets born for free.** The cheap first step to §3:
  `global` starts as a code-defined context (its accessors are platform
  composition anyway); a data node appears only when someone needs to
  define on it at runtime.
- **The GlobalItx/ProjectItx typing question (§5) gets its answer**: one
  typed caps interface per code context, declared next to its definitions;
  `ProjectItx` = builtins & the chain's caps. Types compose the way the
  runtime resolves.
- **Forking picks ancestry**: `itx.fork({ extend: "platform:codemode" })`
  splices a code context above the project — the node stores parent NAMES
  (sturdy refs into the code realm — Law 2 clean); resolution walks the
  list. The codemode-session replacement (§4) becomes literally this.
- **Versioning falls out**: code contexts version with deploys; describe()
  can report which deploy's defaults you see, and stored overrides shadow
  across deploys — exactly the semantics you want.

The dynamic half of the original instinct is ALSO right, as a separate
thing: per-context setup that genuinely varies (seeding a session with
request-specific MCP servers) is a real itx snippet run against the fresh
context after fork — actual `caps.define` calls, actual rows, actual audit
events. Static defaults = code context; dynamic setup = snippet (data).
Same verb, two lifecycles, and the platform uses the same public API users
do.

The first slice SHIPPED: `defineCodeContext`
(`src/itx/code-contexts.ts`) is the authoring surface — same verbs as a
REPL snippet, validated at module init so a bad platform default fails
the deploy. `ContextRegistryHost.defaults` is the chain link: the
registry falls through to it on lookup miss, own rows shadow by name,
and describe() reports inherited caps with the code context's name as
owner. `platform:project` ships with `ai` (a BindingCapability loopback)
as the first hardwired built-in to become an ordinary definition; child
contexts inherit it through the existing per-call parent delegation, no
extra wiring.

The migration SHIPPED: `repos`, `workspace`, and `worker` are now
ordinary `platform:project` definitions (ReposCapability /
WorkspaceCapability loopbacks; the ProjectWorker forwarder with a
members inner replay) — their handle getters, the reserved names, and
`callWorkerFunction` are deleted. The enabling change: **chain
delegation carries the ORIGINATING context** (`itxInvoke` gains
`origin`; the registry injects it as the `context` attribution prop), so
the context-SCOPED workspace still resolves per caller — a forked child
gets `itx:ctx_…`, the project gets `itx` — even though the definition
lives two links up. One behavioral change: `itx.worker.fetch` no longer
special-cases to project ingress (it replays `fetch` on the worker's
default export like any other member); use the ingress URL for the
homepage.

Still kernel, deliberately: `streams` (the access model and global-
namespace gating live there — resolution checks access, which a cap
definition cannot express), `caps`, `fetch` (Law 5), `fork`, `project`,
`projects`, `describe`.

Open: the splice API shape on fork; ref naming for code contexts
(`platform:` prefix?); can a context _revoke_ (not just shadow) a code
default — tombstone rows? Defer until someone needs them.

## 9. Egress is a capability; the intercept tunnel is a live cap — SHIPPED (D23)

Where PR #1466 left it (DECISIONS D22): `project.fetch` IS egress, ingress
never touches the Project DO, but `egressFetch` itself still lives on the DO
because two things live in its memory — the captun intercept tunnel and the
per-request "is a tunnel active?" decision that gates secret substitution.

The claim: **egress is just another capability**, and once you say that, the
captun machinery dissolves.

- **The egress pipe is a stateless entrypoint.** `ProjectEgress` already
  fronts it; the work is moving substitution OUT of the DO: a stateless
  worker can read secrets through the secrets capability and apply policy
  from a cache (KV) — it only needs the DO when something genuinely
  durable/exclusive happens (minting an approval, answering "is there an
  interceptor right now?"). Human-in-the-loop approval slots in HERE, as a
  policy verdict (`allow | deny | hold-for-approval`), not as DO plumbing —
  the hold parks the request and appends an approval-requested event; a
  human (or rule) appends the verdict; the pipe resumes. Egress policy
  becomes data the same way cap definitions are.

- **The intercept tunnel is `provide`, not a protocol.** Today: a bespoke
  WebSocket endpoint on the DO's fetch path + the captun library + tunnel
  lifecycle code. With capnweb-over-WebSocket (github.com/iterate/capnweb
  fork), a connected client just provides a live cap that shadows egress:

  ```ts
  using itx = await connectItx({ context: projectId });
  await itx.caps.provide({
    invoke: "path-call",
    name: "fetch", // shadows the default egress pipe
    target: new MyEgressShadow(), // call({ args: [request] }) -> Response
  });
  ```

  Session-bound semantics come free (live caps die with the connection —
  exactly the tunnel's disconnect behavior, no `onDisconnect` bookkeeping).
  The secret-withholding rule ("an active interceptor never sees real
  material") stops being a special case in `substituteProjectEgressSecretHeaders`
  and becomes a property of the egress cap's policy: requests routed to a
  live `fetch` shadow get placeholders withheld, period. SHIPPED (D23):
  the withheld-text substitution mode is deleted; shadows see raw
  placeholders.

- **Sequencing.** (1) Land the capnweb WS transport — DONE. (2) Reframe
  egress as a defined cap on the project context (default target: the
  stateless `ProjectEgress` pipe) so `live` shadowing works with zero new
  concepts — this is also a §8 code-context default. SHIPPED in the
  consolidation pass (2026-06-10): the cap is named `fetch`, not `egress` —
  it shadows the very name both doors dispatch. (3) Delete captun + the DO's
  tunnel accept + the `fetch` WS exception; at that point the Project DO has
  NO fetch surface at all ("maybe there's a scenario where the project DO
  has neither fetch nor ingressFetch nor egressFetch — that might be nice,
  just nothing"). SHIPPED (D23): the intercept tunnel is dead and the
  default pipe is the stateless EgressPipe — the Project DO supervises
  dispatch but never sees secret material (secrets are D1 rows; substitution
  and the terminal fetch run in a plain isolate). captun remains only for
  the public `/__iterate/captun` relay.

Open: where does a held request park while awaiting approval (DO alarm?
queue? the egress stream itself)? Does the live `fetch` shadow apply to
ALL callers on the context or only for the session that provided it
(current: all callers, like the old tunnel)? Latency budget for
policy-cache reads on the hot path?

## Consolidation pass (2026-06-10 night)

Three collapses, no new concepts:

- **One verb.** `provide` IS `define` with a live target: the registry's
  `define()` takes `SerializableCapTarget | LiveCapTarget` and discriminates
  structurally — a serializable target is a plain data object (prototype
  `Object.prototype`/null) carrying `type: "rpc" | "url"`; ANYTHING else is
  a live stub. The plainness check runs before any `.type` probe because
  property access on a capnweb stub returns a truthy pipelined stub. The
  `itxProvide` node verbs are gone; `caps.provide` survives as a one-line
  alias for REPL muscle memory.
- **fetch demoted from kernel to platform default.** `platform:project`
  defines `fetch` (invoke `path-call`, wire shape
  `call({ path: [], args: [request] }) → Response`) whose target is the
  terminal `ProjectEgress.call` → Project DO `egressFetch`.
  `ProjectEgress.fetch` (globalOutbound) and the handle's `itx.fetch` both
  dispatch REGISTRY-FIRST through the cap — the default dialing `.call`,
  not `.fetch`, is what breaks the loop. Egress interception is therefore
  just cap shadowing: define a live `fetch`, all project egress (both
  doors) flows through your provider until you disconnect/revoke; then the
  default resurfaces. Security property, on purpose: a shadow provider
  receives `getSecret(...)` placeholders UNSUBSTITUTED — substitution only
  exists in the default pipe inside the Project DO. `ProjectEgress` joined
  `DIALABLE_LOOPBACKS`, scoping strictly by registry-injected
  `props.projectId` (renamed from `props.project`).
- **One context-node shape.** `createContextRegistryHost`
  (src/itx/registry-host.ts) builds the registry host for BOTH the Project
  DO and ContextDO; only identity, audit destination, and `defaults` differ
  (children still pass none — their misses walk the real chain).

The kernel is now `caps, streams, fork, project, projects, describe` plus
sugar (`fetch`, `cap()`). Follow-up debt: the captun egress intercept
tunnel is now expressible as fetch-cap shadowing and should be deleted (see
New debts).

## Follow-ups pass (2026-06-11)

- **`streams` joined the platform defaults.** The collection/stream classes
  moved to `src/itx/caps/streams.ts`; the `StreamsCap` loopback is the
  platform:project definition, pinned to the owning project's namespace by
  registry-injected props. The GLOBAL namespace stays kernel — it is gated
  on the connect-time access set ("all" = admin), which no cap definition
  can express; the handle getter branches. Chained calls
  (`itx.streams.get("/x").append(e)`) ride RPC promise pipelining in every
  real execution mode (capnweb and jsrpc both pipeline onto returned
  targets); the subscribe path through the extra registry hop is e2e-proven.
- **The egress intercept tunnel is DELETED** — fetch-cap shadowing is the
  intercept mechanism (the e2e fixture's `egressFetch` option survives,
  reimplemented as a live `fetch` cap on a dedicated itx session).
- **Durable-object dials are name-scoped**: the registry dials
  `itx:<projectId>:<name>`, so an allowlisted namespace's itx-reachable
  instances are disjoint per project by construction.
- **The REPL editor consumes types.ts verbatim** (?raw into the TS virtual
  FS); the hand-maintained ambient shrank to a prelude of session globals.

## The address unification (2026-06-11 → SHIPPED 2026-06-12)

Owner direction from review, captured as the design of record for the next
arc. The through-line: **the system has one data structure — the cap
target — and everything that today is a bespoke concept becomes a use of
it.** "Node", "global", "platform defaults", "live vs durable", and
`itx.caps` all dissolve.

### 1. A context's ADDRESS is a CapTarget — SHIPPED

A context is, operationally, anything that answers the context protocol
(`itxInvoke / itxProvideCapability / itxDescribe / itxRevokeCapability` —
the `RegistryStub` shape). A cap target is precisely "how to obtain an RPC surface". So
context addresses ARE targets:

```ts
// the project context: a Durable Object hosts a project (it already
// does; the address finally says so)
{ type: "rpc", worker: { type: "durable-object", binding: "PROJECT", name: "…" } }

// an agent session
{ type: "rpc", worker: { type: "durable-object", binding: "ITX_CONTEXT", name: "ctx_…" } }

// global: a STATELESS context — just a named loopback entrypoint.
// Nothing special; if it ever needs a durable layer, point the name at a
// DO address and nothing else changes.
{ type: "rpc", worker: { type: "loopback" }, entrypoint: "GlobalContext" }

// the platform defaults: ALSO a stateless context at a loopback address.
// ContextRegistryHost.defaults stops being a bespoke mechanism and
// becomes an ordinary parent pointer (the in-process map may survive as a
// dial fast-path, but conceptually it is an address like any other).
{ type: "rpc", worker: { type: "loopback" }, entrypoint: "PlatformProjectContext" }
```

Parent pointers are stored as addresses (`descriptor = { id, address,
parent: address }`), and chain delegation needs zero new machinery: the
registry already dials every target kind for caps — delegating a miss to
the parent is the same `resolveTarget`. One dial mechanism for everything.

`projectDoStub.itx()` (or `.address()`) returning the target completes the
SturdyRef picture from persistent.capnp that this doc already cites:
`save()` returns the sturdy ref, `restore(ref)` returns the live
capability; `resolveItx` is already named the restorer.

What falls out:

- **Host swapping is invisible** — stateless ↔ durable is a one-line
  address change behind a name.
- **User-space context hosts**: a `source` ref with a durable-object facet
  export means user code can HOST a context — the ProjectWorker litmus
  symmetry, applied to contexts.
- **Federation, accidentally**: `{ type: "url", url: "wss://…/api/itx/…" }`
  is a valid parent. Cross-deployment chains were not designed for; the
  unification simply permits them.
- The string-sniffing dies: `GLOBAL_CONTEXT_ID`, `isChildContextId`
  prefix checks in the restorer and `parentStub`, the registry-host
  selection switches.
- ContextDO may dissolve into **facets of the Project DO** (the facet
  machinery already exists for caps): colocated storage, one less
  namespace.

Two splits keep it honest:

- **Identity ≠ address.** `ctx_abc` remains the identity (audit,
  workspace scoping, origin-carrying); the target is the address. Today's
  string conflates them — the design separates them.
- **Restore stays gated.** Addresses are pure names with zero authority.
  The connect edge keeps short refs bound to grants ("restoring is itself
  a capability"); raw targets are the realm-internal format, never a
  bearer credential.

### 2. Durability is a property of the HOST — superseded by everything-writable-is-durable (see the final statement below)

Every context has a **session layer** (in-memory, dies with the
connection) and, iff its host has storage, a **durable layer**. Defining
always works; what varies is where the row lands:

- serializable target + durable host → durable row (survives);
- serializable target + stateless host → session row (your admin script
  defines three caps on the global context for its own lifetime);
- live target → session row, always (a connection cannot be persisted —
  the rule has no exceptions; workerd#6087 may change this someday).

The satisfying part: **the session layer already exists** — today's
"live table" on the Project DO is it. "Live caps" and "defines on a
stateless context" were the same concept all along; "stateless contexts
are read-only" (an earlier framing in this doc) was the wrong frame.

### 3. `itx.caps` dissolves into root verbs — SHIPPED

The `caps` namespace exists to dodge name collisions, but reserved names
already exist as a mechanism. Kernel flattens to root:
`itx.provideCapability() / itx.revokeCapability() / itx.describe() /
itx.fork() / itx.invoke()` — the `ItxCaps` class dies, and the
`itx.describe()` vs `caps.describe()` duplication resolves to one merged
view. A handle is **an address, an access set, and five verbs**.

### 4. Definitions live at PATHS — longest-prefix dispatch — SHIPPED

REVERSES §4.5's "no dots in names" — deliberately. That rejection was
about namespace organization and remains right for it; this is about
**interception granularity**:

```ts
// shadow ONE method of an inherited cap; everything else falls through
await itx.provideCapability({ path: ["slack", "chat", "postMessage"], target: reviewQueue });

await itx.slack.chat.postMessage({ … });  // → reviewQueue
await itx.slack.users.list();             // → chain → the real slack cap
```

Resolution rule: at each context, the **longest defined prefix** of the
call path wins and is dialed with the _remainder_ as the call path; no
prefix → delegate the whole path up the chain. Still one deterministic
lookup per node; the registry resolves prefixes it was explicitly given
and never traverses provided objects — §4.5's actual concern survives.
This is the per-method mock / approval-gate / fork-with-one-override
story (`provideCapability({ path: ["workspace", "gitPush"], … })` on a
session).

### SHIPPED (2026-06-11): one dispatch mode; `types` on provide/describe

- **`invoke` died from the kernel.** The registry knows exactly one calling
  convention — `target.call({ path, args })` — and the members/path-call
  CHOICE moved to the edges where the concrete object lives: the dial wraps
  concrete objects (env bindings, loader entrypoints, facets) with
  `asPathCallable` (path-proxy.ts), first-party loopback entrypoints
  self-replay via a one-line `call(input) { return replayPathCall(this,
input); }`, live providers implement `call` themselves or wrap
  client-side with `asPathCallable` (extends capnweb RpcTarget, so the
  replay runs in the provider's process), and forwarders keep their inner
  mode as THEIR props (`ProjectWorkerProps.invoke`, `UrlDialProps.invoke` —
  `WorkerInvokeMode` in project-worker.ts). `CapabilityInvoke`, the stored
  `invoke` column, and the field on provide/describe/events are gone.
- **`types` joined `instructions`.** `provideCapability({ types })` stores
  TypeScript declarations for the cap's surface as the `types` meta
  convention field (machine/editor counterpart of the human-facing
  `instructions`); `describe()` lifts both.

### Also queued from the same review (smaller, independent)

- **`itx.project` is mislabeled and needlessly kernel**: it is the
  Project DO's admin surface, not "the project" (a narrowed itx IS the
  project). It becomes an ordinary platform default via a first-party
  loopback (`ProjectAdmin`), with the itx\*/fetch masking moved inside the
  entrypoint; rename to something honest (`admin` / `node`) in the same
  move. (`itx.worker` already fell to this treatment in §8.)
- **Global streams** then either remains the one kernel exception or the
  dial-time injected props grow an `access` field alongside
  `capability`/`context`/`projectId` — the same trusted-identity channel that
  origin-carrying already established.

### SHIPPED (2026-06-12): the final shape — the journal is the only authority

The whole wave-(f)+ arc (the §5 core/processor debate, the evening lock, the
facets/journal-paths review, and the end-of-review LOCK) landed as one
implementation; the in-flight subsections that used to live here collapsed
into this statement. What shipped, in the locked terms:

- **One class.** `Itx extends StreamProcessor` (`src/itx/itx.ts`;
  `ItxContract` in `src/itx/contract.ts` via `defineProcessorContract`).
  The pure functions — `reduceItxJournalEvent`, `resolveLongestProvidedPrefix`,
  path validation, the live-vs-address discriminator — stay module-level and
  are unit-tested over an in-memory journal without workerd. Three names,
  three questions, as locked: `Itx` (what), `ItxDurableObject` (where),
  a stub (how).
- **The journal is the only authority.** provide/revoke APPEND
  `capability-provided`/`capability-revoked` (path-keyed payloads carrying
  the full address) and SELF-INGEST through the one consumption door
  (append, then catch-up from the checkpoint — read-your-writes with no
  waiting machinery; duplicates inert by offset). Live provides journal the
  EVENT while the stub stays an instance field; teardown appends
  `capability-disconnected`; replay marks live entries disconnected.
  DELETED: `DurableItx`, the `itx_capabilities` SQLite table (dropped on
  sight on old instances), every fire-and-forget audit append, and the
  `ITX_AUDIT_STREAM_PATH` vocabulary — "audit log" stopped existing as a
  concept; the journal is the record and state is its fold (the standing
  doctrine, docs/domain-objects-and-stream-processors.md).
- **Creation is an event.** `extendContext` (`src/itx/journal.ts`) mints the
  id, appends `context-created { id, name, parent: { id, address } }` as the
  journal's first event, and returns a handle; the context materializes
  lazily by consuming its journal; the fold takes the first birth
  certificate and ignores later ones. ContextDO's initialize RPC and
  descriptor SQLite table are gone — `ItxDurableObject.descriptor()` derives
  from state. No idempotency keys as a correctness mechanism anywhere in the
  flow.
- **Defaults live on the parent chain — Option 2, as locked.** ONE
  capability map per context; the platform defaults are the provides of the
  read-only, code-rooted `PlatformContext` loopback entrypoint
  (`src/itx/platform-context.ts`), addressed `{ type: "rpc", worker:
{ type: "loopback" }, entrypoint: "PlatformContext" }` and dialed
  in-process as the project core's `parentItx`. Chain:
  ctx → project → platform:project (code). Shadowing,
  revoke-resurfaces-the-default, and deploy-updates hold as chain
  consequences; "platform:project" remains the owner string. The
  constructor-capabilities/defaults-map mechanism is deleted.
- **Identity is a stream coordinate.** Journals live at
  `<host base>/itx[/<child-id>]` — the host's OWN context at `<base>/itx`
  (the project's is `/itx`, the old audit path, by uniform rule rather than
  coincidence), children at `<base>/itx/<id>` (agents:
  `<agentPath>/itx/<id>`). `itx` is a reserved stream path segment with one
  clear error at the user-facing append doors; journals remain ordinary
  readable streams in every viewer. The generic host's DO NAME is the
  coordinate verbatim (`<namespace>:<journalPath>`); identity/journal/
  self-address are projections of the name. Bare `ctx_…` refs resolve
  through the `itx_contexts` D1 catalog (directory role only). Origin
  travels as `{ id, address }`, so origin dial-back and the egress
  dispatcher never pay a directory lookup.
- **Workspaces de-itx-ified.** `itxWorkspaceId` and the `itx:<id>` colon
  strings are deleted; `WorkspaceCapability` takes an explicit
  `props.workspaceId`. The platform context provides the project workspace;
  the AGENT host provides its own `workspace` capability bound to its
  context's identity, journaled on that context. Semantic change, on
  purpose: plain extensions now SHARE the project workspace through the
  chain — isolation is a host's decision, not kernel magic.
- **Processor-mode execution arrived.** `script-execution-requested` with
  `enqueued: true` runs in the processor via the existing runner (detached:
  a script's own provides re-enter the serialized ingest) and appends
  `script-execution-completed`; `pendingExecutions` in state makes
  at-least-once reruns detectable and completed pairs inert. The synchronous
  /api/itx/run door writes the same two events as a record — both modes
  converge on one journal vocabulary.
- **The locked ergonomics** (from the evening review) shipped first:
  `extend` replaced `fork`; `itx.parent` is kernel (an extension's parent
  from its birth certificate; the project's parent IS the platform
  context); `provideCapability({ path|name, capability, instructions?,
types?, meta? })` with `Capability = Function | live stub |
CapabilityAddress` and bare-function auto-wrap (asPathCallable
  semantics); the dial-time attribution prop is `capabilityPath`; provides
  return `{ revoke(), [Symbol.dispose] }` with dispose auto-revoking ONLY
  live provides. The two committed acceptance e2es (middleware via a
  bare-function fetch shadow + itx.parent; indirection via origin
  dial-back) live in `src/itx/e2e/itx-fork.e2e.test.ts`.

Still queued from this arc (deliberately not built):

- **`itx.narrow({ scopes })`** — handle sugar over extend + GuardCapability
  rows; fine-grained access stays zero-kernel-mechanism.
- **Facet embedding for rich hosts** — agents keep their own
  ItxDurableObject instances today; `ctx.facets`-hosted processors
  (`ProcessorDurableObject`) remain the recorded direction.
- **Global as a named instance of the generic host** (and its journal as the
  project-lifecycle surface); global handles stay connect-minted views until
  something needs to write on the global context.
- **Retention**: dispose-deletes, idle-TTL alarms for anonymous contexts,
  catalog/cascade via ownership.
- **Artifact-addressed source** (`{ type: "source", source: { artifact,
commit, entrypoint } }`) — source as a dimension separate from the
  execution mechanism.
- **The 500-line workshop** as a standalone teaching document; the build
  order now exists as `src/itx/README.md`.

### SHIPPED (2026-06-12): callsite purity — plain objects are capabilities

We're allergic to weird wrappers and helpers that aren't just a capnweb or
Workers-RPC stub at the itx callsite, so the last one died:

- **`asPathCallable` is DELETED** (the export, the re-exports, the REPL
  global). Dispatch decides instead: in the core's live-cap borrow
  (itx.ts), a target that does not implement `call` as a function has the
  remaining path replayed onto its members via `replayPathCall` — so
  `provideCapability({ name: "answer", capability: { ultimate: () => 42,
deep: { thought: (q) => … } } })` works directly, callable at any depth
  through the fallthrough. Earlier mentions of `asPathCallable` in the
  dated entries above describe the superseded shape.
- A CALL-implementing provider keeps its documented semantics (one
  `call({ path, args })` owns the whole method tree — the SDK shape); a
  bare function still auto-wraps (empty remainder calls it).
- **describe() dropped the owner noise.** Own entries carry NO provenance
  field; inherited entries carry `from: <owner>`, and the defaults
  render as `"defaults"` (PLATFORM_PROJECT_CONTEXT_ID stays internal).
  Journal records keep their `owner` field unchanged — this is a
  describe()-projection change only.

## Resolved (was open, now decided)

- ~~Two invoke modes as registry data?~~ → ONE dispatch mode (2026-06-11):
  the kernel always dispatches `target.call({ path, args })`; the
  members/path-call choice moved to the edges (dial wraps concrete objects
  with `asPathCallable`, loopbacks self-replay via `call`, live objects
  wrap client-side, forwarders keep inner mode in props). `invoke` is gone
  from provide/describe/rows/events; `types?: string` (machine-facing
  counterpart of `instructions`) landed on provide + describe in the same
  move.

- ~~Naming: `define`/`cap` vocabulary?~~ → The capability rename landed
  (2026-06-11): `define` is dead as a verb everywhere — the handle root is
  `provideCapability` / `revokeCapability` (ONE provide verb for durable AND
  live targets; the target kind decides), plus a public root
  `invoke({ path, args })` (the explicit dispatch form) and the explicit
  accessor `capability(name)`. Wire verbs: `itxProvideCapability` /
  `itxRevokeCapability` (itxDescribe/itxInvoke unchanged). Events:
  `cap-defined` + `cap-provided` merged into ONE
  `events.iterate.com/itx/capability-provided` (payload `kind` records
  live vs durable), `cap-revoked`/`cap-disconnected` →
  `capability-revoked`/`capability-disconnected`, and the script pair is
  `script-execution-requested`/`script-execution-completed`. Every `Cap*`
  identifier is spelled out (`CapabilityTarget`, `CapabilitySource`,
  `CapabilityInvoke`, `RESERVED_CAPABILITY_NAMES`, …), the dial-time
  attribution prop `cap` is now `capability`, the registry table is
  `itx_capabilities`, and `ItxCapIngress` → `ItxCapabilityIngress`. The itx
  streams loopback took the `StreamsCapability` name; the streams DOMAIN
  entrypoint that previously held it is now `StreamsBackend`
  (`getStreamsBackend`, `streams-backend.ts`).

- ~~Script calling convention?~~ → ONE shape: `async (itx) => …`, the single
  argument is the handle. No conventions in the runner; parameterization is
  the caller's concern (/api/itx/run bakes its `vars` into the source).
  All ctx-era vocabulary swept; `extractCodemodeScript` accepts the documented
  `async (itx)` function shape only.
- ~~project-worker ref mechanism?~~ → SHIPPED, then the union kind DELETED
  on review ("just have a ProjectWorker named entrypoint on the loopback
  type"). The one spelling: `worker: { type: "loopback" }, entrypoint:
"ProjectWorker", props: { export, invoke?, …params }`. The forwarder
  crosses to the Project DO as data (loader entrypoints can't cross RPC)
  and replays against `getEntrypoint(props.export, { props })` on the
  freshly built worker. The §1 litmus test is a live e2e: first-party
  McpClient and a user-space class pushed to the project repo, same shape.
- ~~url-ref dial: HTTP batch or WebSocket?~~ → WebSocket, always — a
  stateless worker holds a socket for a request's duration just fine, and
  a real session keeps pipelining. `newHttpBatchRpcSession` is banned
  repo-wide (`iterate/no-capnweb-http-batch`). Header secrets resolve via
  the SecretsCapability loopback inside UrlDial, not by routing the
  handshake through the Project DO (which would put the DO in the socket's
  data path for the session's lifetime — Law 7 in spirit).
- ~~How can a context-scoped cap (workspace) live on a parent context?~~ →
  Chain delegation carries the ORIGINATING context: `itxInvoke({ …,
origin })`, set by the first delegating hop, preserved upward; the
  registry's dial-time `context` injection uses it. Without this, a
  workspace cap inherited from platform:project would bind every child
  context to the project's shared workspace — agent-session isolation
  requires the origin (no-backcompat protocol change, 2026-06-10).
- ~~Where do §8 defaults hook in?~~ → `ContextRegistryHost.defaults`: a
  `CodeContext` (name + validated cap map from `defineCodeContext`) the
  registry falls through to on lookup miss. Own rows shadow; describe()
  merges with the code context's name as owner; child contexts inherit
  through the existing parent delegation.
- ~~Does alchemy handle DO class deletion?~~ → Yes (#1464,
  OutboundMcpFromOurClientCapability): removing the namespace emits the
  deleted_classes migration. Tombstone only needed when durable stream
  subscribers dial the namespace (CodemodeSession).
- ~~capnweb error identity?~~ → capnweb 0.8.0 drops custom error names on
  reconstruction (`ERROR_TYPES[name] || Error`, props loop skips `name`).
  ItxError detection is duck-typed via code/details, never name/instanceof.
- ~~Keep the legacy define compat paths?~~ → DELETED (2026-06-10,
  no-backcompat decision): the legacy define inputs (`source`/`kind`), the
  `codeId` spelling of `cacheKey`, stored `worker`/`facet` kinds, and the
  `source_json` rollback column are all gone. `caps.define` takes a
  `target` (SerializableCapTarget) only, and stored rows are read back
  verbatim — no normalization on read.

- ~~Root registry from day one?~~ → Global context gets the same anatomy as
  every context; no special-casing. Authority lives in access, not in node
  shape.
- ~~Is `namespace` always a project?~~ → No. Namespaces are the unit;
  `global` is one; repos/streams/workspaces are namespace-curried
  collections (§3). Don't build around project-ness.
- ~~Binding-cap authorization granularity?~~ → Finer than pass-through:
  bindings arrive wrapped in a thin policy entrypoint with attribution
  props (§2).
- ~~`kind: "facet"`?~~ → Dies. Stored-source caps are
  `{ type: "rpc", worker: { type: "source" } }` targets discriminating on
  `source.exportType: "worker-entrypoint" | "durable-object"` (§1). The
  facet is instantiated by the DO hosting the context (Project DO or
  ContextDO); its private SQLite lives inside that host.
- ~~Verb/kind taxonomy (pushed/dialed/hosted)?~~ → Rejected as unclear.
  From the context's perspective there are exactly two directions:
  **inbound** (live connection) and **outbound** (everything else) — but
  direction is _derived_, not API. The API is a name + a `target` whose
  kind is the CapTarget union (§1); the `target | source | address` triple
  is also rejected.
- ~~Flat nine-kind CapTarget?~~ → Rejected on review ("too much stuff,
  all very suspicious"). Collapsed to three: `live | rpc | url`, with
  `WorkerRef` naming where an rpc target's worker lives. MCP/OpenAPI are
  client implementations (ordinary RPC targets, first-party or user-space),
  not protocol values on `url`; `url` takes `headers` that pass through
  egress secret substitution (§1).
- ~~`ItxAccess`?~~ → Rejected ("don't invent something else"). The handle
  carries the auth system's principal verbatim — `ItxPrincipal`, hand-typed
  from `~/auth/principal.ts` so drift is a type error (§5).
- ~~`CapMeta` with an `http` schema?~~ → Too leaky. Arbitrary metadata with
  one convention: `instructions`, surfaced by `describe()` (§5).
- ~~Is `config-worker` a primitive WorkerRef kind?~~ → No — and neither is
  `project-worker`; the kind is gone entirely. The `ProjectWorker`
  loopback forwarder is the whole mechanism (user export + inner invoke
  mode ride in props). Not a `source` worker either — its code lives in
  the project's build artifact (the registry points, never pins) (§1).
- ~~Access model granularity?~~ → Shipped in #1418: Better Auth admin role +
  `project:<id>` scopes, nothing else. One seam in the code for finer-grained
  later; no implementation now. Global authority = admin (§3).
- ~~`global` vs `root`?~~ → `global` (leaning; it's the existing literal
  namespace name, e.g. Slack webhook receiving streams).

## New debts (2026-06-10 evening)

- ~~The captun egress intercept tunnel
  (`acceptProjectEgressInterceptTunnel`, the DO `fetch` WS exception, the
  intercept-aware branch of `substituteProjectEgressSecretHeaders`) is now
  expressible as cap shadowing — a live `fetch` cap intercepts both egress
  doors with session-bound semantics for free (consolidation pass, §9 step
  2 shipped). Delete the tunnel machinery in a follow-up once its remaining
  users move over.~~ → DELETED, replaced by fetch-cap shadowing: the DO's
  tunnel accept/route, the ingress forward, the
  `projectEgressInterceptActive` substitution branch, and the e2e fixture's
  captun tunnel are gone (the fixture's `egressFetch` option now defines a
  live `fetch` cap over an itx session). captun itself stays for the
  public-tunnel relay (`/__iterate/captun/`).
- ~~`itx.workspace.git.*` nested RpcTarget broken~~ → DELETED. The flat
  `gitClone`/`gitAdd`/`gitCommit`/`gitPush`/`gitStatus` methods are the
  surface; nested RpcTargets returned from entrypoint getters do not
  survive RPC boundaries reliably, so don't ship one.
- ~~Vite allowedHosts blocks the dev tunnel host~~ → Historical tunnel-era
  misdiagnosis. The config is `allowedHosts: true`; the 403/502s came from a
  wedged vite process behind the still-connected cloudflared tunnel.
  Restarting the dev server fixed it. Current local dev uses
  `localhost:<port>` plus `<slug>.localhost:<port>` project hosts; use captun
  or preview when a public URL is required.
- prd cleanup after tombstone soak: CodemodeSession class + stale stream
  subscriber events, then namespace deletion (mechanically proven safe).
- Legacy `executeCodemodeFunctionCall` methods on capability entrypoints —
  delete once nothing dials them; `packages/shared/src/codemode/*` rename.
- Fetch-cap shadowing never sees UrlDial's WebSocket handshakes; url-cap
  traffic is invisible to a live `fetch` shadow. The capnweb fork (#1474)
  makes WS-bearing Responses cross CAPNWEB hops, but the UrlDial → Project
  DO hop is Workers jsrpc, which still cannot carry one — routing url dials
  through `egressFetch` (and thus the `fetch` cap) stays blocked on that.
- §5's REPL-consumes-types.ts is still open: the editor's ambient typings
  (`itx-repl-types.ts`) are maintained by hand next to a "keep in sync"
  note; deriving them from `src/itx/types.ts` is a tooling exercise nobody
  has needed badly enough yet.

## Open questions (rolled up)

1. Event-provided caps: was the want replay/auditability or authoring
   ergonomics? (Position assumes ergonomics → SDK helper, no new event.)
2. Per-context stream path scheme for execution events (`/itx/ctx_…`?).
3. One generic `BindingCapability` wrapper entrypoint, or bespoke thin
   wrappers per binding (AI gateway logic vs browser vs queues)?
4. Global context's stream as the project-lifecycle audit surface — confirm.
5. Uncurried `{ namespace, … }` accessor pattern uniformly across
   repos/streams/workspaces — confirm shape.
6. Egress-as-capability (§9): where held-for-approval requests park; whether
   a live `fetch` shadow applies to all callers or per-session; policy
   cache latency on the hot path.
