# Project core: a smaller sibling to the clean room

This note is an audit and a design decision record for a new
`packages/v3/project-core`. It does not propose changing
`packages/v3/project-worker`; that package is dirty and remains the useful
reference implementation.

The intended core is a project-confined computer with named context paths,
one durable append/follow mechanism, dynamic project code, and one fetch gate
for both ingress and egress. Repositories, the config worker,
write-only secrets, approvals, and signed events belong in that story. The
hard constraint is strictly fewer than 5,000 raw authored lines, including
source, UI, tests, configuration, and scripts. Markdown research is outside
the counter; implementation must not be hidden there or in generated code.
The public tutorial and a minimal UI/MCP server are
part of the product, not afterthoughts.

This began as a design audit. Source counts below are the initial snapshot,
not a current recount. The current implementation and acceptance status live
in the [README](../README.md); its public TypeScript contract is
[`ScopeTarget`](../src/types.ts). Sketches below are not additional shipped APIs.

## What the current clean room proves

`project-worker` has already proved several important platform facts:

- One context Durable Object can own a stream, its derived state, loaded code,
  and a fetch-capable request path. Context identity is `{projectId, path}`;
  `cd(path)` is addressing rather than an allocation.
- A durable stream with monotonically ordered offsets can recover processors
  after eviction. The current implementation makes append the commit point,
  reduces committed events, and gives subscription delivery an explicit
  cursor/retry/halt model.
- A socket-bearing `Response` cannot cross an RPC hop. Fetch/upgrade traffic
  therefore needs real `fetch()` hops, while ordinary calls can use Workers
  RPC/capnweb.
- A raw capnweb callback is request/session-bound. A context DO cannot simply
  hold it and invoke it from another request. The existing edge-owned pager
  loans a fresh Workers-RPC stub to the DO on demand, then returns it so the DO
  can hibernate.
- Source should have a stable address. The older OS design's
  `{type:"repo", repo, commit, path, bundle?}` address and immutable
  `(repo, commit, path, bundleConfig)` build cache are the right starting
  point; runtime/bundler choice is an adapter behind it.

References: `project-worker/LAYERS.md` (layers 0--5),
`project-worker/docs/itx-surface-as-built.md` (the shipped surface),
`project-worker/src/iterate-context-durable-object.ts`,
`project-worker/src/stream/stream.ts`,
`project-worker/src/context/rpc-stub-directory.ts`,
`project-worker/src/fetch/rpc-stub-fetch.ts`, and
`apps/os/docs/simplification/explain-referee.md` sections 2 and 5.

## Why this must be a new shape

The reference is not near the 5,000-line target. On this worktree, its
`src/**/*.ts(x)` is 14,847 lines; the full package's TypeScript/TSX, including
tests, is 45,180 lines. Some concentrated costs are:

| Current implementation                        | Lines | Reason it is expensive                                |
| --------------------------------------------- | ----: | ----------------------------------------------------- |
| `stream/stream.ts`                            |   656 | SQLite append/read/checkpoint and recovery            |
| `stream/subscription-delivery.ts`             |   655 | two delivery contracts, backpressure, retries, alarms |
| `stream/processor.ts`                         |   559 | facet processor checkpoint/reduce machinery           |
| `iterate-context-durable-object.ts`           |   790 | surface composition and lifecycle                     |
| `rpc-stub-directory.ts` + `rpc-stub-relay.ts` |   630 | arbitrary live callback hibernation protocol          |
| `iterate-context.ts`                          |   407 | generic surface and session-scoped verbs              |

The present surface also includes generic `ItxExpression` parsing/printing,
dotted proxy dispatch, arbitrary rewrite rules, live `provide`, two kinds of
subscription targets, facets, Worker Loader surfaces, and connector libraries.
Those features are coherent for a general capability host, but they are not
the smallest explanation of a project runtime. Reusing them would import the
majority of the cost and make the tutorial explain machinery before the
project's actual model.

## Recommended primary architecture

Use **explicit RPC targets and typed route specs**, not a generic expression
language or a generic capability table. There is one project namespace and one
context implementation; the external surface is deliberately small:

```ts
interface Project {
  context(path?: ContextPath): Context;
  fetch(request: Request): Promise<Response>;
  repos: RepoCatalog;
  secrets: SecretCatalog; // metadata + write, never material read
  config: Config;
}

interface Context {
  append(input: AppendInput[]): Promise<CommittedEvent[]>;
  read(after?: Offset, limit?: number): Promise<EventPage>;
  subscribe(input: SubscriptionRequest): Subscription; // transport-specific
  state(): Promise<ContextState>;
}

interface ProjectWorker {
  processEvent(event: EventRecord): Promise<void>;
}
```

The current spelling is `scope.cd(path)`, not the sketch's `context(path)`.
Named contexts currently map to DOs; this does not mean every file-like
resource must allocate a DO. Public paths name resources and placement stays
private, as described in [path-first identifiers](../IDENTIFIERS.md).
A processor is a repo-addressed or inline dynamic worker subscribed to selected
event types. The implementation calls `processEvent(event)` and supplies the
scoped host through `this.env.ITX.get()`. Named processors are configured with
`itx.set` keys such as `processor/audit`; there is no automatic
`/repos/config/iterate.worker.ts` convention in the current runtime.

This is a deep module: callers learn append/read/subscribe, a repo source,
and fetch. Storage selection, worker-loader caching, DO lifecycle, delivery
cursor recovery, secret substitution, and runtime deployment stay inside the
implementation. The execution adapter can later be Cloudflare Worker Loader,
Workers for Platforms, or Deno Deploy/Cell without changing the project
interface or deployed E2E contract.

The three live primitives remain explicit: capnweb bidirectional capability
lending, the one native fetch gate, and streams. Lending is physical rather
than syntactic: a capability gets an opaque UUID key; the edge holds its
capnweb stub; a hibernatable native DO WebSocket pages the edge; and the DO
borrows a Workers-RPC `call(path, args)` wrapper only while active. It releases
all borrowed legs at idle. `src/lending.ts` records the compact companion
module and its lifecycle proof. This preserves arbitrary callbacks and loaded
facets without importing generic expression parsing or rewrites as the naming
system.

### Event envelope and signature levels

Signature status must be kernel data, attached before any reducer or worker
sees an event. Do not make every application event parse its own provenance.

The original singular-signature sketch is superseded by
[`provenance.signatures[]`](signatures.md), with up to 16 distinct signers.
The independent signing helper used by public-network tests gives a concrete
two-signer example on a fresh bootstrap context with no configured trust keys:

```ts
import { keyPair, sign } from "../e2e/support.ts";
import type { EventInput, Scope } from "../src/types.ts";

declare const scope: Scope;
const context = (await scope.inspect()).context.name;
const alice = await keyPair();
const bob = await keyPair();
const input = { id: "review-1", type: "review.approved", data: { revision: "r17" } };
const signed: EventInput = {
  ...input,
  provenance: {
    parents: [],
    signatures: [await sign(context, input, alice), await sign(context, input, bob)],
  },
};
const [stored] = await scope.append(signed);
console.log(stored?.verification); // unknown valid keys: level 1, not trusted level 2
```

The signed bytes bind the domain, project-qualified context, ID, type, data,
parents, and optional producer. The platform assigns time and offset: those
are not caller-signed fields. Verification records signer IDs, their trust at
commit, and policy offset. Levels mean unsigned (0), valid signer (1), or
configured trusted signer (2), not an independently proven human principal.
Lockdown is context-wide, not per event family. Identical retries return the
original event; the same ID with different content conflicts. Historical
verification is not silently reclassified after key rotation.

### One fetch gate

`Project.fetch` is the only outward fetch capability and the worker's fetch
handler is the only ingress. Both call one `FetchGate.handle(request, route)`:

1. The edge strips internal headers, identifies the project and ingress route,
   and enters the gate. It does no policy evaluation itself.
2. The gate evaluates durable, typed route rules against method, host/path,
   direction, and signature/principal requirement. A rule can dispatch to a
   repo-addressed fetch worker, deny, or pass.
3. A pass resumes the same gate below the current rule using an internal,
   authenticated continuation marker. It is a native fetch hop, preserving a
   WebSocket upgrade; bounded hop count turns accidental self-forwarding into
   a clear error.
4. At egress only, the terminal substitutes allowed secret placeholders,
   pins the final origin, uses `redirect:"manual"`, performs the request, and
   records the effect outcome. Rule code sees placeholders, never material.
5. At ingress only, the terminal dispatches a configured app/worker or returns 404. The same route table explains the UI and MCP discovery output.

Approval is a route-worker/library feature over the stream:
`approval.requested` is appended; a qualified signed
`approval.decided { requestId, allow, expiresAt }` is required before the
rule forwards; `approval.released` or `approval.denied` records the outcome.
The gate itself enforces that the decision meets the route's signature level
and is unexpired. This preserves the material wall: no dynamic worker reads a
secret or bypasses egress merely because it can write approval events.

The current fetch proposal documents the non-negotiable 101 rule and final
secret substitution ordering in `project-worker/docs/plan-one-fetch-rules.md`
(D2--D4). The sibling should retain those invariants without retaining the
generic expression/rewrite mechanism.

### Repos and config worker

Start with a project-local repo catalog and exactly one reserved `config` repo.
The required repo operations are compact: create/import metadata, commit a
snapshot, read a file/snapshot by immutable commit, and resolve `latest` to a
commit. A worker source is either a small inline tutorial fixture or
`{ repo, commit | "latest", path, bundle? }`; the runtime receives resolved
immutable bytes. A build is a cache, never an address.

The config worker is loaded from the config repo and owns project behavior in
ordinary code. It receives event batches through `processEvent`; it can append
derived facts, request approvals, and issue `Project.fetch`, but it cannot
access secret material or install a new fetch terminal. Config change is an
event naming the source snapshot and build result, so a replay says exactly
which code interpreted an event.

### Subscription contract

For the primary path, keep stream subscription simple and durable:

- `subscribe({ after, types? })` creates an edge WebSocket/SSE transport.
- The edge reads committed events in offset order and records the consumer's
  acknowledged cursor in the context DO. On reconnect it resumes from that
  cursor or a caller-supplied offset.
- Backpressure has a fixed byte/event window. When the consumer falls behind,
  terminate with `RESUME_FROM_OFFSET`; it reconnects and catches up. No silent
  event loss and no unbounded in-memory queue.
- A config worker is a durable subscriber with its own checkpoint. Before its
  `processEvent` call, persist enough work/cursor state to retry after eviction;
  retry policy and a halted state are observable.

An arbitrary capnweb callback is a first-class live capability: it is lent
under an opaque UUID and the subscription record names that UUID. The edge
holds the callback, while the DO retains only the hibernatable pager and
borrows a native `call(path, args)` target during activity. The same mechanism
serves loaded facet callbacks. Stream consumers still acknowledge offsets, but
their callback can be re-paged after a context hibernates rather than being
reduced to an edge-only convenience.

## Architectural forks that must stay separate

Do not blend these paths; doing so spends the line budget while preserving the
largest source of lifecycle complexity.

| Fork                                                    | Choose when                                                                                                                                                        | Consequence                                                                                                                                                                                                                                              |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A. Explicit project core with lending (recommended)** | Config workers, browser/UI and MCP clients need event subscription, fetch, repos, approvals, fixed typed calls, and arbitrary capnweb callbacks after hibernation. | Preserve a small opaque-key pager/borrow/return module, but no generic expression parser or rewrite table. Capability naming stays in typed project records. Fits the 5k target if lending stays a single `call(path,args)` bridge.                      |
| **B. General live-capability host**                     | Callers need arbitrary persistent mounts, aliases, expression rewriting, or generic `provide(match,target)` semantics.                                             | Adds the generic naming/evaluation layer on top of lending: expression grammar, rewrite table, capability introspection and their lifecycle proof. This is the current clean-room direction and is unlikely to fit with all requested features under 5k. |
| **C. Stateful dynamic workers/facets**                  | Project code needs durable in-memory actor state beyond event-sourced `processEvent` checkpoints.                                                                  | Host a loaded Durable Object class as a context facet, name/version it from a repo snapshot, and add its upgrade/delete/recovery rules. Keep it an opt-in phase after A; do not make it the processor implementation by default.                         |

Fork B is not an optimization. `project-worker/docs/itx-surface-as-built.md`
sections 1, 2, and 6 demonstrate why its foundation is necessary: capnweb
values are session I/O, so hibernation requires a recoverable edge route. Fork
A retains that foundation. B begins only when arbitrary syntax and target
resolution become part of the durable project model.

## Line budget

This is a planning cap for authored product code, excluding generated types,
vendor code, and tests. It leaves margin for an actual tutorial and UI instead
of declaring victory at 4,999 lines of kernel only.

| Area                                                   | Target LOC |
| ------------------------------------------------------ | ---------: |
| Types, event envelope, canonical signing/authorization |        270 |
| Context stream, SQLite storage, append/read/checkpoint |        800 |
| Durable config-worker subscription/retry/halt          |        450 |
| Context/project RPC and named path routing             |        280 |
| Repo catalog + snapshot/source resolver                |        500 |
| Dynamic worker loader adapter                          |        300 |
| Fetch gate, typed route rules, secret terminal         |        600 |
| Approval/key policy reducer                            |        250 |
| Opaque-key live lending pager/relay                    |        350 |
| UI, MCP server, and tutorial example source            |        450 |
| Deployment/E2E harness and shared utilities            |        200 |
| **Total**                                              |  **4,450** |

This budget requires one delivery model, one default worker, and a small typed
route model. It excludes current clean-room features that have no requested
proof: dotted expressions, aliases/rewrite mounts, generic remote connectors,
multi-facet orchestration, ephemeral high-rate audio, and arbitrary
in-process stateful actor APIs. It includes generic live lending as a physical
primitive, but not generic syntax for naming or composing it.

## Tutorial, UI, MCP, and deployed E2E proof

The tutorial should be executable code organized as six progressive levels,
each deployed as a separate fixture configuration rather than a second toy
kernel:

1. Create a project, address `/` and `/support`, append signed/anonymous
   events, and reconnect a browser subscription by offset.
2. Add the config repo with `processEvent`; prove its derived event appears
   exactly once logically after a worker restart/redeploy.
3. Add a repo snapshot update; show the event stream naming the precise worker
   source revision.
4. Configure an ingress route and an egress allow rule; prove ordinary HTTP
   and WebSocket upgrade pass through the one gate.
5. Store a write-only secret, use its placeholder at an allowed origin, and
   prove a dynamic worker/MCP caller never receives material. Prove redirect
   and origin mismatch are rejected.
6. Require an approval signed at `principal` level, show a pending request in
   the web UI and MCP `list_tools`, append a decision with a test key, and
   prove one released effect plus a durable audit event.

Each level needs only enough UI to reveal contexts, stream tail, current
signature level, route state, pending approvals, and config snapshot. The MCP
server should expose the same read model and constrained verbs (`contexts`,
`events.tail`, `repos.snapshot`, `approvals.decide`, `routes.list`) so the
tutorial has two real clients of the same interface.

The acceptance suite must target a deployed preview, never a Miniflare-only
assertion. For every level it should:

- deploy an isolated project-core preview and wait for a version/smoke route;
- use capnweb/HTTP from a separate process to exercise append, subscribe, and
  a deliberate reconnect; assert durable offsets and processor checkpoint;
- hit the ingress HTTP and WebSocket routes; assert the 101 survives;
- inspect the external test receiver for exactly one egress after approval and
  none before/after deny or expiry;
- redeploy or force an actor wake between append and worker processing, then
  assert recovery rather than a merely healthy response;
- query the UI and MCP endpoints for the same event/approval/source state.

Cloudflare-specific deployment glue is an adapter. The protocol-level E2E
contract above is what allows a later Cell/Deno target to be validated against
the same fixtures.

## Requirements still needing a product decision

The primary path covers arbitrary durable capnweb callbacks through opaque-key
lending. The remaining product decision is whether a user may name and compose
those callbacks through a generic durable expression/mount language. That is
fork B, not a missing helper; the primary path deliberately exposes lending
only through typed project records and APIs.

The first implementation should also make two policy choices visible in its
bootstrap configuration: whether anonymous append is enabled initially, and
which test principal key can approve route effects. Both must be project data,
not environment-only escape hatches.
