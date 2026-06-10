# itx: what's next (working notes)

Status: NOODLING. This is the running list of things we want to fix or build in
the itx layer, with positions and open questions. Nothing here is committed;
when an item graduates it gets its own task/PR and the spec
(`itx-spec.md`) gets amended. Companion docs: `apps/os/src/itx/README.md`
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
  | { type: "loopback" } // the platform worker's own exports (first-party code)
  | { type: "project-worker" } // the project worker (user space) — sugar, see below
  | { type: "durable-object"; binding: string; name: string }
  | { type: "source"; source: CapSource }; // a dynamic worker materialized from stored source
```

`project-worker` is NOT a primitive: it normalizes at define time to
reaching the first-party `ProjectWorker` loopback forwarder with this
project's id (the registry already injects context attribution). It is not
a `source` worker either — its code lives in the project's build artifact
and changes on deploy, so the registry can only point at it, never pin it.
The dedicated spelling exists purely so `entrypoint` always names the
export YOU call (not the forwarder) and `describe()` stays informative.

(Revised on review from a flat nine-kind union: the Workers-RPC-reachable
kinds — binding, loopback, entrypoint, durable-object, config-worker,
dynamic-worker — were all secretly the same thing, "an RPC target in some
worker", and collapsed into `rpc` × `WorkerRef`. The full per-kind
docstrings live in `apps/os/src/itx/types.ts`, which is the design of
record.)

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
first-party `McpClient` must be the SAME shape, just reached via
`{ type: "loopback" }` instead of `{ type: "project-worker" }`:

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
  name: "petstore",
  target: {
    type: "rpc",
    worker: { type: "project-worker" },
    entrypoint: "OpenApiClient",
    props: { specUrl: "https://petstore.example.com/openapi.json" },
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
itx.caps.define({ name: "mac",   target: { type: "live", stub } });                                        // inbound, session-bound
itx.caps.define({ name: "slack", target: { type: "rpc", worker: { type: "source", source: { … } } } });    // outbound, durable
itx.caps.define({ name: "ai",    target: { type: "rpc", worker: { type: "binding", binding: "AI" } } });   // outbound, durable
```

RESOLVED (supersedes an earlier `target | source | address` triple, which
was confusing): one field, **`target`**, in different kinds — the
discriminated union above. No separate `source`/`address` arms; direction
is derived from the kind, never spelled by the caller. (Possible authoring
sugar: a bare stub/function means `{ type: "live" }`.) `caps.provide` can
stay as an alias during migration.

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
the only scopes that exist are `superadmin` (server-granted via the `admin`
role only — client-requested scope is always stripped; auto-granted to
`@nustom.com` accounts) and `project:<id>` strings. Superadmin resolves to
access `"all"`; everyone else may do project-scoped things iff the project
id is literally in their scopes. There is no separate "global namespace
grant" — global authority IS superadmin. The code keeps ONE seam where
finer-grained permissions would slot in later; we deliberately build none
of it now. #1418 also already ships the first slice of this section: the
`/admin` UI connects to the global itx over Cap'n Web, and `itx.streams`
on a global handle targets the deployment-wide `global` namespace, gated
on access `"all"`.

Direction, not commitment: if every accessor is restore-with-sugar, the
logical endgame is one literal `itx.restore(ref)` taking a self-describing
ref (`"stream:proj_123:/path"`). Today each collection parses its own ref
format and that's fine; write the direction down so the dotted API is
understood as sugar, and build the universal form only when something needs
it.

Remaining questions:

- Is the global context's stream the audit surface for project lifecycle
  (created/deleted), the way project `/itx` streams audit cap lifecycle?
  (Symmetry says yes.)
- Confirm the uncurried `{ namespace, … }` accessor pattern uniformly
  across repos/streams/workspaces.

## 4. Drop codemode (the proving use case for all of the above)

A codemode session is a child context that doesn't know it yet. The
`CodemodeProcessor` reduces `tool-provider-registered` events into a provider
map — that map IS a capability registry maintained in parallel via streams.
The executor's `ctx` proxy IS the itx path-proxy. `callFunction`'s
longest-prefix provider resolution IS registry dispatch.

The plan:

- A session = `itx.fork()` → a `ctx_…` context.
- Tool providers = caps on that context. The three codemode provider families
  map exactly onto §1:
  - `ctx.ai` → `{ type: "rpc", worker: { type: "binding" | "loopback" } }` (§2),
  - `ctx.mcp.*` / `connectToMcpServer` → first-party `McpClient` entrypoint
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

- **Rename "iterate-config worker" → "project worker" codebase-wide**
  (`callConfigWorkerFunction`, the base iterate-config artifact naming,
  docs, UI copy). Design docs and `types.ts` already use the new name.
- `handle.ts` sheds its direct domain imports (repos/workspace/streams) —
  becomes addresses or injected stubs; kernel approaches the ~500-line goal.
- Document the share token as a sealed SturdyRef (§1).
- Per-cap/per-call usage events at the supervisor (billing + audit hook,
  feeds §2 and §4).
- Global-context implementation: make the node real, wire namespace
  currying through the built-ins. (Polishing its shape beyond that is
  explicitly LATER.)

## Resolved (was open, now decided)

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
- ~~Is `config-worker` a primitive WorkerRef kind?~~ → No. Renamed
  `project-worker` and documented as strict sugar: it normalizes to the
  first-party `ProjectWorker` loopback forwarder with this project's id.
  Not a `source` worker either — its code lives in the project's build
  artifact (the registry points, never pins). Kept as a spelling so
  `entrypoint` always names the export you call (§1).
- ~~Access model granularity?~~ → Shipped in #1418: `superadmin`
  (role-granted) + `project:<id>` scopes, nothing else. One seam in the
  code for finer-grained later; no implementation now. Global authority =
  superadmin (§3).
- ~~`global` vs `root`?~~ → `global` (leaning; it's the existing literal
  namespace name, e.g. Slack webhook receiving streams).

## Open questions (rolled up)

1. Event-provided caps: was the want replay/auditability or authoring
   ergonomics? (Position assumes ergonomics → SDK helper, no new event.)
2. Per-context stream path scheme for execution events (`/itx/ctx_…`?).
3. One generic `BindingCapability` wrapper entrypoint, or bespoke thin
   wrappers per binding (AI gateway logic vs browser vs queues)?
4. Global context's stream as the project-lifecycle audit surface — confirm.
5. Uncurried `{ namespace, … }` accessor pattern uniformly across
   repos/streams/workspaces — confirm shape.
