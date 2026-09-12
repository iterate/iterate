# Control plane on contexts — resolved design

Status: resolved direction, 2026-09-11, **after a four-way review** (three Claude
agents + codex/astra xhigh). Supersedes the open questions in
[control-plane-context-plan.md](control-plane-context-plan.md) for the isolation
model, the RPC hierarchy, and the dispatch door. Clean-room: **no backwards
compatibility**. All four reviews agree the architecture is viable; the security
contract below is the revised, review-hardened version. `(verify)` = proven or
still to prove; `(later)` = deliberately deferred.

## Implementation status (2026-09-11)

Shape first, insecure on purpose, security captured as expected-fails — per the explicit "get the
shape in place and clean first, before we write thousands of lines threading permissions everywhere"
direction. **All six increments landed as SHAPE** (typecheck + full workers lane green — 781 passed,
22 expected-fail; committed locally, not pushed):

1. **Context hierarchy** — `Session`→`SessionRpcTarget`, `IterateContext`→`IterateContextRpcTarget`;
   `GLOBAL_PROJECT_ID`; `session.user` vends a global context (same surface as a project's).
2. **`IterateRpcTarget`** — the one `/api` root with `authenticate({ from-server-cookie | admin-secret })`,
   served at `/api` and `/internal/rpc`; `UnauthenticatedSession` deleted.
3. **Single `invoke(call, args, caller)` door** — `invoke`/`invokeAs` collapsed; the `Caller` is
   CARRIED through every dispatch and sibling hop, but NOT enforced (nothing reads it to refuse yet).
4. **`session.organizations.get(id)`** — the org context catalog.
5. **Account contract + `AccountProcessor` + best-effort async auth fact** — the account-view reducer
   (a kernel `StreamProcessor`, no D1) and the durable `authenticated` fact on `session.user`.
6. **Security spec** — `__workers-tests__/control-plane-contexts.test.ts`: passing shape/account
   tests + five `test.fails` for the naughty things the path-mask must refuse (pass while insecure,
   flip red when enforcement lands).

Deferred — the ENFORCEMENT and heavy plumbing (by direction; the expected-fails are its spec):

- **Path-mask authorization** — the `authorize(caller, path)` that READS the carried `Caller` to
  allow/refuse (the destination floor at `resolver.invoke` + the pager attach) plus the append
  type-gate. This is the "threading permissions" to wire when we enforce.
- **Privileged `ctx.exports` account facet + D1/OAuth** — for the token-workflow effects (Phase 2);
  the foundation processor needs none.
- **Full `/internal/rpc` deletion** — needs the OAuth-gate admission rework (admin via `/api`).

## Headline from the review

The architecture (shared global namespace, one dispatch spine, privileged
class-backed facet) is sound. But **"check authority at the resolver" is not a
complete floor**: returned capabilities (handles) execute stored closures
directly, bypassing the resolver _and_ outliving its async-local caller. So the
model is: **capture authority at every capability boundary and fail closed**, not
"check one chokepoint." Five concrete gates were missing (they're specified
below). None of it requires a general scope language or a deferred-effect
scheduler for the foundation.

## The spine: one internal dispatch shape, authority stamped server-side

There is one **internal** dispatch shape, `invoke(call, args, caller)`, but the
**client-facing method stays separate** — the edge `IterateContextRpcTarget.invoke`
keeps its `(call, ...args)` signature and the platform **stamps the `Caller`
server-side**. A `caller` parameter is never added to any capnweb-exposed method
(that is the anti-forgery invariant: a client can't set it because it can't reach
a method that takes it). The confirmed reason this holds: the DO's dispatch is
Workers-RPC only, capnweb terminates at `/api`, and no raw DO stub is ever handed
to a client.

```ts
type Caller = {
  principal: Principal | null; // WHO — identity; stamped on appends, checked at the destination
  scopes?: string[]; // the grant's permissions (e.g. "account", "iterate") — carried now
  // pathScope?: …                // path-pattern authority — (later); NOT needed for the foundation
};
```

- **Missing `Caller` / null principal FAILS CLOSED.** A null caller is never
  treated as platform/trusted. The reduce/delivery loop runs principal-less today
  (`iterate-context-durable-object.ts:456-463`); it must be given an explicit
  platform `Caller`, not left null.
- **The resolver stays caller-free.** `ItxExpressionResolver.invoke`
  (`itx-expression-rewriting.ts:527`) is an internal object; it takes an **injected
  authorize closure** that reads the established async-local `Caller` and refuses
  when absent. Do **not** thread `caller` through every expression helper — codex:
  "adding a caller parameter to every helper gains little; capturing authority at
  asynchronous capability boundaries gains a lot."
- **No `trust` field.** A distinguished internal platform principal (below) makes
  trusted-vs-client inferable from `principal`. Per-credential authority is
  `scopes` (carried now) and, later, a path scope.

### The platform principal (new — required)

Introduce an **internal-only** platform principal, `{ actor: "platform" }` (name
TBD), that **no `authenticate`/token path can ever produce** and that is
**distinct from `admin`** (today `verifyAdminSecret` returns a _client-presentable_
`{actor:"admin"}`, `principal.ts:140`, `session.ts:78` — so `admin` must NOT be
the platform principal). Set it explicitly on the reduce/delivery loop and on
platform fact publication. The write-gate keys on this exact value; the fetch-lane
principal parser rejects it arriving from the wire; missing ALS never implies it.

## The RPC hierarchy (names end in `RpcTarget`)

```
newWebSocketRpcSession<IterateRpcTarget>(url)          // /api — the ONLY door
  └─ IterateRpcTarget        authenticate(credentials): SessionRpcTarget   (+ serverInfo/apiVersion)
        └─ SessionRpcTarget  whoami() · projects · user · organizations · consent · grants · logout
              ├─ projects.get(id)/create()/list()  → IterateContextRpcTarget   (project runtime root)
              ├─ user                              → IterateContextRpcTarget   (the caller's user)
              └─ organizations.get(id)             → IterateContextRpcTarget   (an org)
```

- **`/internal/rpc` and `UnauthenticatedSession` deleted.** One `/api` door;
  operator/admin is a credential variant of the same `authenticate`.
- Renames `Session → SessionRpcTarget`, `IterateContext → IterateContextRpcTarget`.
  User, org, project are all `IterateContextRpcTarget`.
- `authenticate({ type: "from-server-cookie" })` (browser), `{ type: "admin-secret" }`,
  project-secret/token variants. **`authenticate` reuses the admission-time auth
  result** (`rpc.ts` already receives an `Authorization`) — it does not re-run
  verification. **One successful authentication per connection.**

## Coordinates: one shared global namespace — and reserve it everywhere

```ts
type ContextCoordinates = { projectId: string | null; path: string };
```

`projectId: null` = deployment-global, encoded `global.iterate` (port
`apps/os/src/domains/durable-object-names.ts`, `allowNullProjectId` opt-in).

| Coordinates                          | Meaning                              | Variable           |
| ------------------------------------ | ------------------------------------ | ------------------ |
| `{ null, "/principals/users/<id>" }` | a user's control-plane context       | `userItx`          |
| `{ null, "/orgs/<id>" }`             | an organization                      | `orgItx`           |
| `{ null, "/projects/<id>" }`         | a project's control-plane **record** | `projectRecordItx` |
| `{ "<id>", "/" }`                    | a project's **runtime root**         | `projectItx`       |

**H1 (live gap — must fix): reserve the encoding at EVERY admission path.** Today
nothing reserves `"global"`: `reachesProject("every", …)` is always true, and
`createProject` slugifies with no reserved-word check, so **any signed-in user can
create a project named `global`** and `stringify({projectId:"global",path:"/"})`
=== `"global.iterate/"` — the deployment-global root's DO name. Refuse
`projectId === "global"` (and any name carrying the `.iterate` suffix) in
`projects.get`, `projects.create`/`projectSlug`, MCP `projectOfToolCall`, and
project-host routing; `reachesProject`/`reachableProjects` must never return it.

Rejected: a namespace-per-principal — a principal's reach is a _set_ (own context

- orgs + projects by permission), and shared project-record nodes can't live in a
  per-principal namespace. (Codex notes the Session could instead vend separately-
  confined user/org/record namespaces like it vends projects; we keep the shared
  global namespace, which is defensible, and pay for it with the gates below.)

## Authorization: capture at every capability boundary, fail closed

Naming a context is free (`cd` is pure addressing); **every action is authorized
at the destination, and every returned capability captures its own authority.**
The transports and how each is covered:

| Transport                                                                              | Coverage                                                                                                                                                                                                                                                                                                                                                                                                                    |
| -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| dotted / string `invoke` / physical `builtins.*` / rewrite targets, and the fetch lane | resolver's injected authorize closure, on the **complete resolved call** (final op + args), reading the ALS `Caller`                                                                                                                                                                                                                                                                                                        |
| **returned handles** (`InvokeHandle`/`FacetHandle`/`RpcStubHandle`)                    | **capture authority at construction**; for the foundation, **don't return live handles on global — return DATA from complete allowed expressions** (see below)                                                                                                                                                                                                                                                              |
| **pager attach / replace / lend / close**                                              | **authorize admission UNCONDITIONALLY, before accepting or replacing any socket** — an _empty_ attachment currently skips `#appendEvents` yet still replaces a pager and can remove rules (`rpc-stubs.ts:228`, `iterate-context-durable-object.ts:145`). Strip pager/upgrade headers from ordinary client & confined-worker fetches; construct them only in the trusted relay; bind lend/cleanup to the admitted attachment |
| fetch-upgrade leg + WebSocket frames                                                   | bind to an authorized pending fetch (`rpc-stubs.ts:851`); they don't evaluate expressions                                                                                                                                                                                                                                                                                                                                   |
| raw `append` / `read` / `lendRpcStub` / `rpcStubTransportState`                        | **make private local dependencies** — reachable only via the authorized door, never as RPC methods (today they bypass every gate incl. principal-stamping; latent, not live)                                                                                                                                                                                                                                                |
| egress `fetch`, `kv`/`secrets`/`repos`/`cfArtifacts`                                   | **refused by omission** — not in the global built-in record, so `Object.hasOwn` refuses them (`itx-expression-rewriting.ts:541`); no per-call check. A one-line `projectId===null → 403` guards the raw `#egress` path defensively                                                                                                                                                                                          |

### Returned capabilities (the deep finding)

`InvokeHandle` is an `RpcTarget` whose `invoke`/`applyRoot` run a stored closure
directly (`expression.ts:505`); facet/rpc-stub handles close over `#invokeFacet`/
`invokeRpcStub` without re-entering the resolver. So `invoke("itx.facets.get('account')")`
returns a handle the caller can invoke later, bypassing the resolver **and** the
first call's ALS caller. **Foundation fix:** on global contexts, refuse bare
handle returns; expose only **allowed read methods that return data**
(`itx.facets.get('account').liveSnapshot()` returns `{rev,state}`, not a handle).
`(later)` if handles are returned, each must capture an immutable `Caller` at
construction and re-enter authorized dispatch when used.

### Read wall — account authority, NOT subject identity alone

Subject-equality (`actor === <id>`) is **not sufficient**: OAuth gives the same
user actor to account-authorized and project-limited grants (`oauth.ts:99`);
personal tokens are minted with only `iterate` scope (`grants.ts:169`); account
ops already require a separate `account` permission (`grants.ts:45`). So `.user`
access requires **`actor === pathUserId` AND the caller's `scopes` include
`account`** — carry the account permission into the destination check. This is not
a scope language; it's preserving an existing permission bit.

### Write wall + control verbs on global

On a **global** context a non-platform client may:

- **append only** `events.iterate.com/account/*-requested` (subject == caller), and
- establish **only its own** narrowly-validated live-state **callback**
  subscription (platform-constructed configuration).

**Everything else is platform-only on global**, refused by construction:
arbitrary-target `subscribe`, `provide`/rewrite installation, `processors.enable/disable`,
and **facet mutation methods** — `facets.get('account')` exposes read methods
only; `processEventBatch`/`catchUpFromLog` are reserved for the parent's private
delivery (else a client injects fabricated facts and advances the checkpoint past
real events — `sdk/index.ts:92`, `processor.ts:229,391`). Why control appends are
platform-only: a subscription/rewrite **target** is an arbitrary expression whose
head the delivery loop **executes** (even at configure time,
`subscription-delivery.ts:594`); under the platform principal a target containing
`itx.builtins.append(fabricatedFact)` would forge an authoritative fact. On
**project** contexts the current behavior is unchanged (intra-tenant).

## The account processor: a privileged class-backed facet (confirmed)

An exported DO class of this worker, hosted `ctx.facets.get('account', () => ({ class: ctx.exports.AccountProcessorRpcTarget }))`,
running with the worker's real env. Confirmed against workerd source (an exported
DO class without its own configured storage is a valid facet class, constructed
with its worker's environment). Notes:

- Add **`enable_ctx_exports`** to **both** the deploy config and the worker-test config.
- Keep the privileged stub **parent-private**; `processEventBatch` is driven only
  by the parent's delivery, never by a client.
- Use **`oauthHelpers(env)`** (`oauth.ts:190`) for the OAuth provider API — it's
  constructed from env bindings, so no manual `OAUTH_KV` manipulation and no
  dependence on the fetch-handler-only `OAUTH_PROVIDER` binding.
- `StreamProcessorDurableObject` assumes `env.ITX` (`sdk/index.ts:133`), so the
  privileged host needs **explicit parent-stream `ITX` wiring** (an
  `itxEntrypointFor` its `/` context) to reuse the engine rather than fork
  `#invokeFacet` — factor `#invokeFacet` so the load/memo head differs by facet
  kind but the call/watchdog/dispose tail is shared.
- **No alarms** (workerd#6810, class-backed too). Deferred effects use a `(later)`
  append-later backed by the parent DO's alarm; processors stay timer-free.

## Lease & revocation — transport-wide

Keep the **transport-frame-level** lease + teardown (`rpc.ts:64,114`), NOT
Session-method wrapping — contexts are independently returned RPC targets whose
calls don't traverse the Session, and forwarded capabilities bypass `onCall`.
Contract: **one successful authentication per connection; every returned
capability belongs to that connection's authority and lifetime**; revocation
disposes the connection's relays within the existing ≤60s bound.

## Authentication fact — async, at-least-once, idempotent

Publish via `ctx.waitUntil` after returning the Session (not synchronously on the
hot path), **at-least-once + idempotent** on the auth-operation id (the log
supports idempotency keys, `stream/processor.ts:542`). Fire at the
credential-establishment boundary (login, token issue/refresh), not per socket
open. Facts are attributed to the **platform principal** in `source.principal`
with user identity in the payload — invariant: the day a reducer keys off
`source.principal.actor === userId` for a _fact_, user-attributed facts (and
`trust`/`verifiedBy`) return. Acceptance relaxes to "two tabs converge eventually,
deduplicated," not "durable before return."

## cd, self-call, and the trims

- **`cd` stays pure addressing**, both edge and built-in. The DO-side sibling hop
  is just `getByName(sibling).invoke(call, args, caller)` wrapped in an
  `InvokeHandle` — **do not** build an edge-style `IterateContextRpcTarget` inside
  the DO (adds a layer; the destination is the chokepoint regardless).
- **Own-path `this` branch stays as an optimization.** Self-call was **proven not
  a deadlock** (runnable workers-lane test: `getByName(ownName).method()` resolves
  in ~10–16ms for read and write; workerd interleaves inbound requests). The
  deadlock claim was wrong. Rule for future code: never self-call from inside
  `blockConcurrencyWhile` (that _does_ hang); the constructor's appends are
  synchronous, so it's clear.

## Shared React + live-state

The store already has monotonic seed + gap-repair (`client/live-state.ts`);
reconnect needs only a driver (watch socket → rebuild session → re-run
`connectLiveState`). Extract `useLiveState` (`demo.tsx:35`) into a shared module;
add the provider, `useIterateSession`, selector retention/disposal, bounded
reconnect. The client's own subscription is the narrow session-owned callback
above.

## Open items (all `(later)`, none block the foundation)

- **Path-pattern scope language** + attenuation-on-hop (orgs/project-records/cross-project).
- **The project↔record bridge** — a project reaching its own `/projects/<id>`
  record, platform-mediated, one narrow channel.
- **append-later / deferred-effect scheduler**.

## Sequencing

**Step 0 — the spine + the security prerequisites** (do together; the spine alone
is not safe): the internal `invoke(call,args,caller)` shape with server-side
stamping and **fail-closed ALS**; the injected resolver authorize closure; the
**platform principal**; **unconditional pager admission** + header stripping;
**raw `append`/`read`/`lendRpcStub` made private**; reserve **`global`** at every
admission path; **returned-capability handling** (data-not-handles on global);
retain the **transport-wide lease**.

**Phase 1 — foundation:** global coordinates + codec port; `SessionRpcTarget.user`
gated on **account authority**; the **narrow write wall + control-verb refusal**
on global; **bindings refused by omission**; the **privileged account facet** +
async idempotent auth fact; shared React/live-state + reconnect; skip the birth
config-subscription on global.

**Acceptance:** authenticate → own `.user` (refused to a project-only credential)
→ durable auth fact observed in two tabs (eventually, deduplicated) → reconnect;
foreign-subject reads/writes refused through calls, physical builtins, rewrites,
raw history, **returned handles**, **pager attach (incl. empty)**, and facet
methods; a project cannot reach `global`.
