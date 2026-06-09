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
