# itx implementation decisions & learnings

Running log of choices made while implementing `apps/os/docs/itx-spec.md`,
especially where reality diverged from the spec or where the spec left room.
Newest entries at the bottom. See also `README.md` (the architecture document)
once it exists.

## D1: SQLite table is the registry state; stream events are the audit record

Spec §4.2 says "registry mutations append events to the context's stream and
the registry table is the fold." Implemented as: the hosting DO's SQLite table
is authoritative, mutations append audit events to the context stream
best-effort (fire-and-forget with error logging). Rebuilding registry state by
folding the stream on every DO wake would need snapshotting machinery for no
benefit — the DO's own SQLite _is_ the snapshot, transactional with the
mutation. The stream keeps the full history for audit/UI/time-travel.

## D2: No merged name index yet — cap misses delegate up the chain per call

Spec §3.3 calls for a merged name index fetched at itx construction. For now
the fallthrough proxy optimistically returns a path-proxy for any unknown
name and resolution happens at invoke time inside the hosting DO; a child
context DO that misses delegates to its parent. This is one extra DO hop on
parent-owned caps, which is fine at current scale and deletes a whole
cache-invalidation concern. Add the index only when latency data says so.

## D3: Old `provideCapability`/`getConnection` stay untouched until deleted

The legacy connection table (`#capnwebConnections`) uses keys like
`slack-sdk` that are not valid JS identifiers and are accessed via
`project.connections.get(key)`, never via name fallthrough. Migrating them
onto the registry would mean relaxing name validation for a surface that is
scheduled for deletion (user: no backwards compatibility needed). They live
side by side until the old capnweb e2e suite is ported, then both go.

## D4: The supervisor is always in the invoke path

Even for `invoke: "members"` live caps we route calls through the hosting
DO's `itxInvoke` rather than handing the raw stub to the caller. One extra
hop buys: a single audit/policy point (per-cap egress rules later), uniform
offline errors, and no stub-lifetime leakage to remote callers. Exception:
nothing yet — if a hot path needs raw-stub borrowing we'll add it then.

## D5: `itx.project` returns the Project DO stub directly

Spec §9 wanted ProjectCapability's 16 forwarders gone. Workers RPC lets us
return the DO stub itself over RPC (auto-proxied by capnweb), so the project
admin surface is just... the DO's public methods. Zero forwarders, types stay
honest via `ProjectCapability` (the Pick<> of ProjectDurableObject).

## D6: `itx.projects.get()` returns a narrowed Itx handle, not a project object

Narrowing is construction (Law 4): a global handle narrows by constructing a
project-context handle. So `itx.projects.get("x").streams` and a directly
connected project handle's `itx.streams` are literally the same object shape.
The old ProjectsCapability/ProjectCapability split disappears.

## D7: Simplified access model

Per user direction: access is "all" projects, a list of named projects, or
none. `ItxProps = { context, access?, cap? }` where `access` only matters on
global-context handles. Project-context handles imply access to exactly that
project regardless of what props claim — the restorer overwrites, mirroring
the old "config worker can't escalate scopes" rule. Org-membership flows stay
in oRPC for now; `itx.projects.create` is admin-only.

## D8: Worker caps gain network access via ProjectEgress (they had none)

The legacy config worker loads with `globalOutbound: null`. Worker caps (and
the config worker, once rewired) get `globalOutbound = ProjectEgress` instead:
bare fetch() routes through the Project DO egress path with secret
substitution. This is a strict capability upgrade and deletes the
fetch-monkeypatch in the old /run harness.

## D9: Audit event stream path is `/itx`

Registry events (`itx.cap.defined` etc.) append to the context's stream at
path `/itx` in the project namespace. Child contexts will use their own
namespace/path when ContextDO lands.

## D10: Child contexts delegate misses upward per call, depth-recursive

`ContextDO.itxInvoke` checks its own registry, then calls its parent's
`itxInvoke` (project DO or another ContextDO by id prefix). Arbitrary fork
depth works with zero index machinery; `itxDescribe` merges the chain with
child entries shadowing and `owner` carrying provenance. One DO hop per
chain level per miss — revisit only if latency data complains (see D2).

## D11: The restorer is async

Child contexts cost one descriptor lookup (`ctx_…` → owning project) at
restore time. `ItxEntrypoint.context` is a getter returning a Promise, which
`await env.ITERATE.context` already handled — no isolate-side change.

## D12: Facet classes must be NAMED exports

`worker.getDurableObjectClass()` against a default-export DO class produces a
facet whose every call fails with workerd's opaque "internal error;
reference = …" (observed locally on miniflare 4.20260424 / workerd ~2026-04;
Cloudflare's own docs only ever show named exports). `define({ kind: "facet" })`
therefore requires `source.entrypoint`, turning the footgun into an
instructive error at definition time.

## D13: Facet names exclude codeId — data survives code upgrades

The facet is `cap:${name}` regardless of source version, so redefining a
facet cap keeps its private SQLite database (Cloudflare's AppRunner relies
on the same property). If a cap wants a clean slate it can be revoked and
redefined under a new name; explicit facet deletion is future work.

## D14: Registry logs invoke failures at the supervisor

Errors crossing the Workers RPC boundary back to remote callers can be
masked as "internal error; reference = …". `ContextRegistry.invoke` logs the
real error (cap, kind, path, context) before rethrowing — the supervisor is
the one place the truth is always visible.

## D15: agents.e2e "slack-agent event-mode codemode" timeout is pre-existing

The e2e test "completes slack-agent event-mode codemode calls without
blocking the stream callable queue" times out waiting for the slack-agent
processor chain to emit tool-provider-registered on the routed agent stream.
Verified by running the IDENTICAL test from origin/main (3cc317ad8) against a
main-code dev server: it times out there too. Not caused by the itx branch;
also failed on the itx preview deployment, consistent with an upstream
slack-agent/stream-subscription regression that predates this work.

## D16: Security hardening from adversarial review (round 1)

- **Global context is admin-only.** `accessForPrincipal` hands non-admins
  their named projects; the global ("all") handle — and global `/api/itx/run`,
  which inherits the platform's own egress with no per-project
  `globalOutbound` — are gated to `access === "all"`. Non-admins must narrow
  to a named project. (Closes ambient-SSRF for authenticated non-admins.)
- **`replayPathCall` filters reserved segments server-side.** `itxInvoke` is a
  public DO method reachable with a hand-built `path`; the reserved-name gate
  can't live only in the consumer proxy. `RESERVED_PATH_SEGMENTS` is now one
  exported set (protocol.ts) used by both the proxy and the replay, and also
  feeds `RESERVED_CAP_NAMES`, so a cap can never be named a prototype-pollution
  vector or `Function.prototype` member.
- **The path proxy never falls through to `Function.prototype`.** String keys
  always extend the path (unless reserved), so SDK methods named
  `name`/`call`/`bind`/`length` traverse correctly.
- **`itx.project` is a narrow facade** (`ItxProject`: describe/ingressUrl/
  getSummary), not the raw Project DO stub — internal lifecycle methods
  (afterAppend, createProject, getConfigWorker, the itx\* verbs) are no longer
  reachable from a project-scoped handle.
- **Worker/facet entrypoint stubs are disposed after each invoke** (live
  targets are not — the provider owns them).
- **Cap HTTP routing matches names case-insensitively** and dispatches with
  the registry's exact name.

## D17: itx.project is the full Project DO surface (reverses D16's facade)

Owner decision: within a project you get its whole surface — `itx.project`
returns the Project DO stub directly, so Workers RPC auto-proxies every
public method/getter and a newly-added DO method is instantly callable as
`itx.project.foo()` with zero forwarder code. The round-1 review narrowed
this to a facade for safety; the owner explicitly prefers the full surface
under the project-level access model ("you have the project or you don't").
The genuinely dangerous direction — a hand-built `path` into
reserved/prototype names via `itxInvoke` — stays gated in `replayPathCall`
(D16), which is exactly why that server-side filter is load-bearing now.

## D18: ItxError — five codes, duck-typed, tag-don't-redact

Structured kernel errors live in `errors.ts`; full rationale in its doc
comments. The compact version:

- **Wire shape over class identity.** capnweb serializes an error's own
  enumerable props and reconstructs a plain `Error` on the far side, so
  `ItxError` is just `Error` + enumerable `code`/`details` and detection is
  duck-typed (`getItxErrorCode`), never `instanceof`. No rehydration layer.
- **Exactly five codes**: NOT_FOUND, FORBIDDEN, CONFLICT, BAD_REQUEST,
  INTERNAL. No UNAUTHORIZED — auth happens at connect (Law 3), so auth
  failures are transport-level 401s before a session exists.
- **Existence masking**: resolution boundaries (`itx.projects.get`,
  `/api/itx[/run]` context resolution) answer NOT_FOUND for missing AND
  forbidden, byte-identical, so callers cannot probe which ids/slugs exist.
  FORBIDDEN is reserved for cases where existence is established or not
  secret (global streams, append policy, create/remove projects).
- **Tag, don't redact**: the `/api/itx` sessions' `onSendError`
  (`tagOutboundItxError`, wired in `fetch.ts`) rewrites every non-ItxError to
  `ItxError { code: "INTERNAL" }` keeping the original message and stack — we
  trust our callers; returning the error from the hook is also what makes
  capnweb transmit the stack at all. `details` ships in v1 (maximum info).
- **Retry semantics downstream**: `useItxQuery` retries only code-less
  (socket) or INTERNAL errors, once; the stream-tail multiplexer skips
  retry exactly for access errors (NOT_FOUND/FORBIDDEN).
- Verified by the worker harness (`pnpm test:itx-stream-subscribe`) that
  `code`/`details` also survive plain Workers RPC hops, so kernel throws
  born inside `StreamsCapability` keep their codes on the way to capnweb.

## D19: SSR reaches itx in-process; loader prefetch is best-effort

Three pieces, one seam each:

- **`getServerItx` (server.ts)** builds a handle inside the OS worker from the
  request context: `accessForPrincipal` → `resolveAccessibleContextId` →
  `resolveItx` — the SAME chain `/api/itx` connect runs, now shared via
  access.ts so the two auth boundaries cannot drift. No socket, no Cap'n Web:
  the handle is a plain RpcTarget and each built-in call is one Workers RPC to
  the owning DO, which is exactly what SSR latency budgets want.
- **`getLoaderItx` (loader.ts)** is the isomorphic accessor (the orpc/client.ts
  shape): server → getServerItx (dynamically imported, so cloudflare:workers
  and the db layer never enter the browser graph); browser → the per-tab
  socket singleton, moved to react/browser-client.ts so loaders share the
  hooks' socket and project-handle cache without importing React.
- **`prefetchItxQuery` (loader.ts)** seeds the QueryClient with the same
  `ItxQueryDefinition` ({key, queryFn, staleTime} defined ONCE in
  lib/itx-queries.ts) the component's hook consumes, and swallows every
  failure. Prefetch is an optimization, never a gate — a FORBIDDEN thrown
  during route loading crashed the streams page into the generic error
  boundary in prod (2026-06); the component's own useItxQuery re-surfaces the
  same error inline instead. Only the streams index prefetches today;
  breadcrumbs stay lazy by choice and are seeded for free through the shared
  per-path cache keys.

## D20: fetch on the project IS egress; ingress is stateless; creation is events

The Project DO cleanup (PR #1466) landed three postures the spec/notes had
been circling:

- **`project.fetch` = egress.** In itx vocabulary `itx.fetch` is project
  egress (Law 5), so the DO's bare `fetch` now routes to `egressFetch` — the
  worker's `fetch` is the project's homepage. The one exception on the DO
  fetch path is the captun intercept tunnel's WebSocket handshake (upgrades
  cannot cross RPC methods). Endgame, not built: egress as a stateless
  capability with policy cached outside the DO, and the tunnel replaced by a
  live egress-shadowing capability `provide`d over capnweb-with-WebSockets.
- **Ingress never touches the DO.** `ProjectIngressEntrypoint` (stateless)
  asks the DO `getWorkerVersion()` (freshness + deduped rebuild semantics),
  loads the worker itself via `env.LOADER` with the shared cache key, and
  dispatches; the code payload only crosses RPC inside the loader's
  cold-isolate miss callback. The DO is where the worker's source of truth
  lives, nothing more.
- **Project creation is event-sourced, fire-and-return.** `createProject`
  appends `project/create-requested` and returns the (purely computed)
  summary immediately — no waiting. The ProjectProcessor — slug `project`,
  hosted on the DO — runs the idempotent steps (D1 projection, iterate-config
  repo, example secret, agents root) and leaves the trail: `created`,
  `repo-initialized`, `create-completed`, plus a cross-post of
  create-requested to the global namespace's `/projects` stream. Callers
  redirect to the project page right away and watch
  `itx.project.projectProcessor.snapshot()` (phase: creating → ready) for
  progress — the processor is a public RpcTarget property on the DO, directly
  traversable over Workers RPC (capnweb's RpcTarget IS cloudflare:workers'
  inside workerd). Callers that need routing before the processor catches up
  (dashboard, itx.projects.create) insert the D1 projects row themselves
  first, as they always did. The worker build never gates creation (ingress
  self-heals builds); `config-worker-built` remains the historical event
  string. The DO keeps NO bespoke tables: the processor snapshot is the
  project's durable state (with a pure `projectFacts()` + D1-slug fallback
  for cold snapshots), and "config worker" is now just **the worker**
  (`durable-objects/worker.ts`, `callWorkerFunction`, `itx.worker`).
