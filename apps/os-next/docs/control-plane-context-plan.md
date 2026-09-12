# Control plane on contexts

Consolidated design and implementation estimate, 2026-09-11. This records the
decisions, implementation work, and ideas discussed but not yet acted on. Runtime
implementation and deployment have not started for this plan. The existing
[OAuth contract](unified-oauth-architecture.md) remains the starting point.

**Recommended next slice:** real global user contexts, successful authentication
events, and shared Session/context/live-state plumbing. Estimated at **630–1,090
implementation lines plus 500–900 test lines**. Token workflows follow that
foundation. All four main phases total approximately **2,730–4,840 lines including
tests**; the optional per-call activity feed is estimated separately below.

Current decisions:

- Use one SPA with separate platform/project route modules and a shared connection.
- `IterateRpcTarget.authenticate()` returns a handwritten `SessionRpcTarget`
  directly, with no `{ api, info }` wrapper.
- The Session exposes `.user`, `.projects` and, when needed, `.organizations`.
  `.user` returns a genuine user IterateContext; the Session itself is not one.
- Project selection stays on the Session. A context has no built-in project
  catalog, and `session.user.projects` is not part of this interface.
- Project execution is confined to its own namespace, regardless of whether it
  starts from a user call, a processor, or an alarm. Caller permissions never
  enable a project expression to reach another project.
- User context paths are `/principals/users/<user-id>` in the global namespace.
  `/principals/service-admin` remains the proposed identity/audit context for
  the configured admin credential; exposing or creating it is not required for
  this initial user-context plumbing.
- Keep D1 and the OAuth provider authoritative initially; context streams own
  domain commands, operation outcomes, and live projections.
- Allow personal tokens to be persisted and read through authorized account
  state. No show-once delivery protocol is required.
- Record authentication and credential lifecycle facts durably. Per-call
  ephemeral activity is a separate optional idea, not a foundation requirement.

The target API examples below are proposals. The implementation estimates count
new or substantially rewritten handwritten code, not net repository growth.

## Direction

Build the control plane as the first trusted application using the context kernel.
Account and organization modules own contracts, command histories, reducers,
workflows, and live views. The OAuth provider continues to implement the credential
protocol. The browser uses the same authenticated Cap’n Web connection as today.

Latest direction: establish the common programming model before migrating token
workflows. Readable tokens are acceptable in authorized account state; a show-once
credential handoff is not a requirement. The platform application and project
dashboard should have distinct domain modules. Their SPA and deployment packaging
are separate choices, considered below.

The kernel already supplies `StreamProcessor`, `defineProcessorContract`,
`ProcessorEngine`, checkpoints, replay, durable subscriptions, `LiveState`, and
`connectLiveState`. The existing React hook is in `src/client/demo.tsx`; extract
that hook into the shared client module when a product route needs it. Do not
copy the apps/os processor registry or invent another event framework.

## Application modules and the common connection

The platform application owns identity, organizations, membership, project
existence, consent, sessions and tokens. A project dashboard owns the repo viewer,
agents, streams and other tools inside a selected project. These are distinct
domain modules using one programming model. The current v3 dashboard is primarily
a directory and app launcher; the repo/agent dashboard still lives in apps/os.

Every application authenticates into the same handwritten **SessionRpcTarget**.
This includes an app served through a project's custom hostname and fetch-proxied
to another deployment. Project UIs always select their project from the Session;
a hostname never changes the authenticated root into a project context.

The target public layering (proposed wire interface):

```ts
const iterate = newWebSocketRpcSession<IterateRpcTarget>(apiUrl);
const session = iterate.authenticate(credentials); // SessionRpcTarget
const userItx = session.user; // (null, "/principals/users/<user-id>")
const projectItx = session.projects.get(selectedProjectId); // (projectId, "/")
// Cap’n Web can pipeline this chain; a terminal awaited call flushes it.
```

For `someapp.mydomain.com` mapped to project A, a successful app grant has a ceiling
of A. `projects.list()` returns A while the user has membership, and `get(B)` is
refused. The platform application can obtain a grant covering the user's chosen
projects, including current and future membership when explicitly approved. A
selected-project hint can help navigation; it never supplies authority. Account
and consent methods remain permission-checked even though the root interface is
the same everywhere.

The issuer must derive the custom-host ceiling from the verified OAuth client and
the platform's domain-to-project mapping. Client metadata or browser input must
not be able to declare a wider ceiling. The proxy destination does not determine
the ingress app's identity: authentication must still be for the original mounted
app origin. V3 currently recognizes platform project hostnames; custom-domain
registration and its issuer lookup are future work.

Connection sequence:

1. The shared app SDK probes the app's `/api`; a missing session starts its login
   flow. The issuer establishes identity and grants that app its approved reach.
2. The shared server adapter holds credentials in `BrowserSession` and gives the
   browser an opaque cookie. The mounted app uses its own origin's `/api`, even
   when its page implementation is served by a fetch proxy.
3. The SDK opens one Cap’n Web WebSocket. The adapter authenticates its upstream
   request; authentication resolves a principal and returns the authorized Session.
   The platform-host adapter dispatches in process; another origin proxies to the public API.
4. Platform pages obtain account/org handles; project pages obtain project handles.
   These calls and their subscriptions share that socket. Selecting a project
   does not trigger another login or a separate per-project browser connection.
5. The live-state client subscribes **before** reading its seed, then applies
   revisioned deltas. A new connection must resubscribe and seed again. The current
   SDK clears a closed connection but does not yet automatically reconnect an
   already-mounted page; that lifecycle needs explicit wiring in the plumbing.

The existing public API authenticates at HTTP/WebSocket admission and currently
returns an authorized Session directly; its SDK method is called `authenticate`.
The target above makes the three layers explicit at the RPC surface as well.
Wiring that bootstrap must preserve the existing OAuth validation, cookie/origin
checks and live authorization lease. An app's endpoint may be proxied; the
bootstrap → authenticated Session → selected IterateContext shape stays the same.
The exact `credentials` union and browser-cookie binding are implementation details
still to settle against the existing verifier; this is not a proposal for an
additional credential protocol or for putting browser-held bearer tokens in place
of the current server adapter.

| Packaging                                        | Benefit                                                                | Cost / limit                                                                                                             |
| ------------------------------------------------ | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| One SPA, separate platform/project route modules | One shell and connection; smallest immediate change                    | Imports and loaders must enforce separation; a shared shell can affect both                                              |
| Two SPAs on the same origin                      | Separate bundles and route entry points                                | Extra build/routing setup; crossing apps reloads and opens a new connection; shared browser origin and deployment remain |
| Separate origins and deployments                 | Independent releases and browser isolation; fits project-authored apps | Per-origin app cookie/grant and proxy setup; navigation crosses applications                                             |

Decision: establish the domain modules and common context interface
now, retaining one platform SPA with a shared shell and connection. A future project dashboard can be another route
bundle or an independent app without acquiring a different programming model.
Keep project-authored JavaScript on a distinct origin from the issuer. Separate
SPAs on the same origin do not provide a browser security boundary, and separate
bundles in one deployment do not provide independent operational availability.

Platform/account modules must not import project-dashboard implementation. The
platform directory must render without waiting for project DOs: today's
`loadDashboard` waits for per-project app discovery, so that discovery belongs in
separately loading project UI. Backend issuer routing must remain independent of
project config workers. Separate applications can still share navigation and the
same SDK.

## Session and context selection

`SessionRpcTarget` remains a normal handwritten RPC target. It owns the current
credential/grant, directory authorization and the lifetime of the capabilities
it hands out. Its catalog calls are ordinary RPC methods, not Itx expressions:

```ts
const session = iterate.authenticate(credentials);
const alpha = session.projects.get("alpha");
const beta = session.projects.get("beta");
const user = session.user;
```

`session.projects.get(idOrSlug)` retains the existing sequence: resolve the
project, check the Session's permitted reach and current membership, then return
its root IterateContext. V3 currently uses the project slug as its ID. Preserve
the current live revocation checks and teardown ownership.

The Session's `.user` getter is bound to the authenticated human and returns
`(null, "/principals/users/<user-id>")`. A personal API token returns a Session
whose `.user` addresses that same user's context, with access constrained by the
token. Existing personal tokens have project/`iterate` scope, not automatically
account-management scope: exposing the user's context must not silently grant
token inventory, credential values, or consent powers. The admin credential can use the Session's project catalog without a
human account; it does not manufacture a user for `.user`. No additional public
principal getter is required now.

An organization catalog can likewise live on the Session and return authorized
global organization contexts. Global user and organization contexts use ordinary
stream/processor/live-state machinery. Turning the Session or its catalogs into
a context application is parked.

## Project confinement

Once a call reaches a project IterateContext, its namespace is fixed. `cd(path)`
selects another path in that project; built-ins and expression rewriting cannot
select another project. This applies even when the originating Session is an
administrator or can access multiple projects.

```ts
const alpha = session.projects.get("alpha");
alpha.cd("/agents/support"); // still alpha

// No project-selection capability exists on a context:
// alpha.projects.get("beta")
// alpha.builtins.projects.get("beta")
// session.user.projects.get("beta")
```

A caller holding the Session may separately obtain beta through
`session.projects.get("beta")`. Project code, loaded workers and alarms receive
only their project-bound context; the platform does not inject the Session or
its cross-project catalog into them.

This preserves the existing construction-based isolation: the context's project
ID scopes addressing, storage, bindings and loaded code. An alarm can evaluate
an expression using its owning context with no user Session and no ambient OAuth
grant. There is no token-permission lookup needed to decide which other projects
an alarm can enter: it cannot enter another project.

Retain the existing resolver and built-ins. Do not add `projects` to
`BuiltInScope`, add a cross-project context-selection primitive, or propagate
Session project reach through `invokeAs`/async-local state for project selection.
Attribution can travel with a request or durable initiating event for auditing;
it does not widen execution authority.

The same namespace boundary must hold for dotted expressions, string `invoke`,
physical `builtins` spellings, rewrite targets, and alarm/processor execution.
Global user contexts additionally require subject/path restrictions so one user
cannot use `cd` or raw operations to reach another user's private state. That
control-plane access policy does not give project contexts cross-project reach.

## Principals and credentials

A **principal** is the durable identity that can act. A **credential** is the
evidence used to authenticate as that principal. **Actor** names the principal
performing an audited action. See the [v3 glossary](../CONTEXT.md).

| Credential                       | Principal              | Global identity context path              |
| -------------------------------- | ---------------------- | ----------------------------------------- |
| User login or personal API token | The user               | `/principals/users/<user-id>`             |
| Configured admin token           | Built-in service-admin | `/principals/service-admin` (when needed) |

Different credentials can identify the same principal and carry different
permissions. Revoking or rotating one token does not change the principal's
identity or history. Shared admin-token use identifies service-admin, not the
particular human holding the token. Named service accounts and delegation are
outside the first slice.

Principal contexts represent durable identity/state; they do not need to expose
project catalogs. Authentication returns a Session, and that Session provides
access to the relevant contexts.

## User authentication and credential events

The user's context owns their authentication and credential lifecycle history.
The handwritten authentication/Session code publishes trusted facts to
`(null, "/principals/users/<user-id>")`; the account processor reduces them and
exposes the resulting sessions/activity through ordinary live state.

Record successful Session authentication, logout, token issuance/refresh/revocation,
and app-grant approval/revocation as those lifecycle operations occur. Browser
authentication and authentication with a personal API token both publish to the
same user's context. An authentication event identifies the accepted credential
or grant, client/app where known, authenticated Session, timestamp and operation
ID. It contains no raw credential material.

Successful authentication records its fact durably before returning the Session.
Retrying publication for the same authentication operation must not duplicate the
event; a new successful authentication is a new event. Ordinary RPC calls and
live authorization-lease checks within that Session are not new authentications.
Other lifecycle facts follow the durable publication/reconciliation rules below
when their authoritative write happens in separate provider/database storage.

These are platform-published outcome facts, distinct from user-submitted commands;
clients cannot forge them through `session.user.append`. Failed authentication
with no verified user belongs in platform authentication telemetry rather than
being attributed to a user named by untrusted input.

## Audit attribution

Record verified attribution with each accepted command or audited operation:

- The acting principal's stable ID and resolvable principal context.
- A non-secret credential identifier/version and, where applicable, OAuth grant
  and client identifiers. A connection ID is useful correlation, not an identity.
- The operation, target coordinates, timestamp, request identity and outcome.
- When acting on behalf of another principal, both identities and the verified
  delegation. Asynchronous effects retain their initiating event reference and
  identify the executor, so a processor does not erase the original initiator.

Google Cloud's service-account audit examples distinguish the acting service
account from the key used. OAuth token exchange also distinguishes a subject from
an actor when representing delegation. These support the separation above; using
these distinctions does not require implementing token exchange now.
[Service-account audit examples](https://docs.cloud.google.com/iam/docs/audit-logging/examples-service-accounts),
[RFC 8693, actor claim](https://www.rfc-editor.org/rfc/rfc8693.html#section-4.1).

The platform stamps this information from verified authentication and causal
context; callers cannot set it by supplying an `actor` field. Never log credential
material. Keep credential creation/ownership attribution separate from subsequent
use: creating a service account's key does not prove the creator made a later call.
A shared admin secret proves use of that secret, not which human possessed it.

For the current single admin secret, retain stable service-admin attribution;
`/principals/service-admin` is its identity-context path when that context is
needed. A credential identity/version can distinguish rotations. Do not invent
per-human attribution or claim that the existing code already records rotations:
it currently collapses use to `{ actor: "admin" }`. Named service credentials can
provide finer attribution later without changing the context model.

Accepted mutations carry trusted attribution in the affected context's durable
history. A principal's activity feed is a projection of these records, using
durable delivery and stable event identities for deduplication. Avoid a fragile
"write the target, then best-effort append an audit copy" sequence. Authentication
failures, denials and audited reads need records at their trusted admission or
operation boundary; they do not produce target mutation events automatically.
An unverified claimed identity in a failed login is not an authenticated actor.

Preserve accepted intent separately from completion/failure. The principal context
may expose the audit projection through ordinary live state, but its clients
cannot forge or erase the authoritative audit records. A user's ability to submit
commands to their own context does not grant that ability.

## Context coordinates

Use an explicit global namespace in the address model:

```ts
type ContextCoordinates = {
  projectId: string | null;
  path: string;
};
```

`null` means the deployment-global namespace. It does not mean all projects, the
currently selected project, or missing input. `/` is that namespace's root stream.
Use stable IDs and canonical absolute paths:

| State                                       | Coordinates                                                 |
| ------------------------------------------- | ----------------------------------------------------------- |
| User account                                | `{ projectId: null, path: "/principals/users/<user-id>" }`  |
| Built-in operator                           | `{ projectId: null, path: "/principals/service-admin" }`    |
| Organization                                | `{ projectId: null, path: "/orgs/<org-id>" }`               |
| Project's control-plane record, when needed | `{ projectId: null, path: "/projects/<project-id>" }`       |
| Project runtime root                        | `{ projectId: "<project-id>", path: "/" }`                  |
| A runtime agent                             | `{ projectId: "<project-id>", path: "/agents/<agent-id>" }` |

A project's control-plane record and runtime root are different contexts. Give
variables their actual meaning, such as `projectRecord` and `projectItx`; do not
hide the distinction by treating principal, project-record and runtime contexts
as the same target.

apps/os already uses `projectId: null`, encoded as `global.iterate`. V3 currently
requires a string project ID: nullable coordinates and reserved-name handling are
part of the plumbing to add. Prefer this explicit model over a fabricated
`_iterate` project in application code. Each `(projectId, path)` has its own context
and stream; the global namespace is not one giant Durable Object.

Birth and processor installation are explicit. Addressing a path is not account,
organization, or project creation.

Keep existing project DO names unchanged so the foundation does not migrate
project data. Audit and reserve the global namespace encoding at every admission
path, including admin selection, public RPC, MCP and hostname routing. Check for
an existing project-name collision before adopting `global.iterate` in v3.

Nullable coordinates touch more than the name codec: stream identity, `whoami`,
loader identity, and project storage/secret/artifact bindings currently assume a
string project ID. Do not turn those prefixes into a shared `null:` store that
all global users can read. Global contexts need appropriately scoped bindings or
explicit refusal of project-only operations.

## Proposed React interface

Keep the authenticated Session in an app-wide provider. `useIterateSession()`
returns that stored handwritten RPC stub. `useItx(selectContext, dependencies)`
selects and retains a genuine IterateContext from it:

```tsx
const session = useIterateSession();
const userItx = useItx((session) => session.user, []);
const orgItx = useItx((session) => session.organizations.get(orgId), [orgId]);
const projectItx = useItx((session) => session.projects.get(projectId), [projectId]);
const agentsItx = useItx((session) => session.projects.get(projectId).cd("/agents"), [projectId]);
```

`useItx` never returns the Session or the unauthenticated bootstrap. Its selector
must return a context. The hook retains and disposes selected stubs and reselects
when its inputs or authenticated Session change. A project-bound app uses exactly
the same Session and selection sequence. Hook signatures remain proposals.

Extract the existing demo live-state hook and use it with these contexts. Its
`key` identifies the producer and `door` reads that producer's seed. Both account
and project processors expose the same `liveSnapshot` interface. Illustrative
React code (domain state types omitted):

```tsx
function TokensPage() {
  const itx = useItx((session) => session.user, []);
  const account = useLiveState(itx, {
    key: "account",
    door: () => itx.facets.get("account").liveSnapshot(),
  }).value;

  if (!account) return <p>Loading tokens…</p>;
  return account.tokens.map((token) => (
    <label key={token.id}>
      {token.name}
      <input readOnly value={token.value} />
    </label>
  ));
}

function OrganizationPage({ orgId }: { orgId: string }) {
  const itx = useItx((session) => session.organizations.get(orgId), [orgId]);
  const org = useLiveState(itx, {
    key: "organization",
    door: () => itx.facets.get("organization").liveSnapshot(),
  }).value;
  return <h1>{org?.name ?? "Loading organization…"}</h1>;
}

function AgentsPage({ projectId }: { projectId: string }) {
  const itx = useItx((session) => session.projects.get(projectId).cd("/agents"), [projectId]);
  const agents = useLiveState(itx, {
    key: "agents",
    door: () => itx.facets.get("agents").liveSnapshot(),
  }).value;
  return <AgentList agents={agents} />;
}
```

An account form submits a command to its account context, for example:

```ts
await itx.append({
  type: "events.iterate.com/account/token-create-requested",
  payload: { requestId, name, projects },
});
```

The append receipt means the command is durable. Its processor's live state shows
progress and settlement, including the readable token when authorized. There is
no route invalidation or account-specific live-state protocol. The account module can mount convenient
`.tokens` and `.liveState` capabilities on this context using the same mechanism
as project modules. Those capabilities extend the context; its ordinary `append`,
`subscribe`, `cd` and other operations remain. A `.liveState` convenience should
use the same producer interface and revision protocol for every context.

The initial React extraction should retain the existing store and revision-gap
repair. It also needs subscription disposal and resubscription when the app
connection changes. Additional selector sugar can be shared later without changing
the three layers.

## Context authority

Coordinates identify a context; verified authorization determines authority.
A real IterateContext can carry restricted authority while retaining the same
method surface. For global account/org contexts:

- The Session selects its own user context and verifies organization/project access.
- `cd` and all equivalent expression paths preserve that restriction.
- Public appends accept authorized command types and stamp the caller; clients
  cannot forge internal birth, issuance, membership, or settlement facts.
- Read/subscription/facet access expose the authorized state consistently.
- Processor installation and rewrite configuration remain platform-controlled.

The same policy covers raw event history, snapshots, replay, and live deltas;
filtering only the account page is insufficient. Returned capabilities must retain
the restriction and Session revocation lifetime. Global user access must not
become global-root access through an alias, physical built-in, `cd`, or a loaded
worker. Existing project-wide storage semantics remain valid inside projects.

V3 currently relies heavily on project-wide reach and allows `cd` throughout the
project. Path-aware global authority is required new plumbing, not something that
already follows from nullable coordinates. Checks must apply to both ordinary and
physical built-in spellings and to capabilities returned from them. Do not solve
this by renaming a narrow account RPC facade `IterateContext` while removing its
context operations.

Minting rechecks the requesting grant, scopes, project ceiling and current
membership at the effect boundary. Preserve account-scope and issuer-only consent
rules. A project app's grant stays capped to its mounted project even though it
uses the same Session interface. Readable token access must not
allow a caller to acquire a credential broader than its own granted reach.

## State ownership

| Concern                                                                 | First implementation's authority                                                    |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Identity lookup, memberships, project directory                         | Existing primary D1 records                                                         |
| OAuth codes, grants, access/refresh credentials and protocol validation | Existing OAuth provider                                                             |
| Immediate grant denial                                                  | Existing primary D1 revocation markers                                              |
| Account commands, operation progress and audit history                  | Account context stream                                                              |
| Rendered account view                                                   | Live projection assembled from account state and authoritative grant/directory data |

This follows the useful apps/os distinction between processor state and a composed
live view. Not every displayed field must be copied into a reducer. In particular,
do not append an event for every authenticated API request merely to display
last-used time.

There must be a recovery path for a successful provider/database write whose
outcome event was not appended. Use transactionally recorded delivery obligations
where the write and obligation share storage; use explicit reconciliation where
the provider owns separate storage. A best-effort append is not a reliable bridge.
Provider inventory remains the authority for whether a credential exists.

D1 can become an index/projection in a later design, but that requires changing
authorization to read authoritative, caught-up context state, or an index whose
required version is proven. A lagging UI projection must never authorize access.
There is no fundamental requirement that authority live in D1; moving it is a
separate consistency migration, unnecessary for the first slice.

## Token workflow after the foundation

Create one account contract and pure processor. Its durable vocabulary covers
account birth, operation requests, attempt boundaries where needed, and terminal
settlements. Token rows contain IDs, names, project ceilings, expiry, revocation,
and cleanup status. Personal tokens may be persisted and read again through an
authorized account view, including its live state. Keep credentials out of logs.
Read authorization must preserve the caller's project ceiling: permission to list
account metadata does not itself permit reading a broader credential. Provider
refresh credentials do not need to become part of the account UI.

This applies to newly issued tokens whose result is retained. The existing
provider inventory does not reconstruct the raw value of every previously issued
token; migration must represent an unavailable legacy value honestly.

The public shape can stay small:

```ts
// Proposed domain commands on the selected account IterateContext.
await accountItx.append({
  type: "events.iterate.com/account/token-create-requested",
  payload: { requestId, name, projects },
});
await accountItx.append({
  type: "events.iterate.com/account/grant-revoke-requested",
  payload: { requestId: revokeRequestId, grantId },
});
```

The command door validates authority and command identity. An append acknowledges
durable acceptance; processor state records the operation result. The UI renders
live state, including readable personal tokens when authorized. Only form drafts and
other temporary presentation state need to remain local to a tab.

For minting, retain one awaited call to the existing trusted issuer initially.
The account workflow records intent and outcome, but it must not blindly rerun
issuance after a timeout, eviction, or replay. The provider generates a new grant
on each authorization; a stream idempotency key does not make that call idempotent.

Before expanding minting into a background processor effect, prove the small
issuance seam under crashes: stable operation identity in trusted provider
metadata and reconciliation of uncertain outcomes. A negative eventually-consistent inventory read is
not proof that issuance did not happen. An uncertain result stays explicitly
uncertain until reconciled; it does not become an automatic fresh mint.

Persisting the credential result in authorized account state makes a lost browser
response straightforward: reconnect and read it again. No show-once receipt or
delivery protocol is needed. The separate provider-write/context-commit gap still
needs an explicit outcome; readability alone does not make provider issuance
idempotent. This is work for the token workflow slice, not a prerequisite for the
initial context plumbing.

Revocation is the easier processor effect: validate ownership, write the D1 denial
marker, then clean up the provider grant. The UI may show “revoking” after accepting
intent; it shows “revoked” only after the denial marker exists. Cleanup failure is
durable pending work with bounded attempts and a visible explanation. Preserve the
current live-socket/capability revocation bound of at most sixty seconds.

## Trusted host and delivery

The v3 dynamic facet host supplies only its scoped `ITX` capability; it does not
have D1 or OAuth provider bindings. Its `runInBackground` helper also does not
supply the apps/os obligation keepalive, and facets do not have native alarms.
Reusing these types is not enough to claim durable credential workflows.

Use the existing processor host and engine for platform-owned processors wherever
their dependencies permit. The first plumbing slice does not need provider or D1
effects in a facet. When those effects are added, supply the necessary authority
through a narrow issuer/directory adapter; a trusted host, if needed, must reuse
the same engine and delivery semantics. Do not create a second processor framework,
put auth logic into the generic engine, or hand deployment credentials to arbitrary
loaded workers.

Bootstrap commits birth/setup and a durable processing subscription before command
acceptance. A browser-side “append, then wake the processor” sequence has a crash
gap; an alarm on a processor that was never reached does not close it. Reuse the
context's delivery mechanism, or prove an equivalent durable handoff. Add only the
trusted dispatch seam needed for that host.

The current DO constructor installs the project's root config-worker subscription
on contexts. Global bootstrap needs an explicit platform-owned installation path;
it must not inherit a project-owned config worker or expose a common global root
to user code. This is a change to installation and authority, with the existing
processor engine, checkpoints, replay and durable subscriptions retained.

## Optional idea: ephemeral activity for every RPC call

This was a feasibility discussion, not a decision to implement it. The idea is to
see activity in the target context and cross-post it to the authenticated
principal's context, so a user view can show what Jonas is doing across projects.
There is no fundamental blocker to a live activity feed. A complete inventory of
every application call takes broader instrumentation than one context method.

### Coverage and placement

`IterateContext.invoke` sees dynamic Itx expression calls, but defined methods such
as `cd`, `provide`, `subscribe`, processor installation and credential helpers can
bypass it. Authentication and Session catalog calls are handwritten RPC methods
outside it. Returned native or forwarded capabilities can also bypass that hook.

The local Cap’n Web fork has an `onCall` hook around locally dispatched application
functions, including pipelined calls. It supplies target/path information, not a
complete argument record, and does not guarantee coverage of forwarded native
capabilities. Combine it with context expression metadata and instrument the
remaining native/forwarded boundaries if “every call” remains the requirement.
The hook must invoke its supplied operation synchronously to preserve RPC ordering;
do not await a logging RPC before dispatching the real call.

Instrument logical application operations, not individual protocol frames. Decide
whether a nested invocation produces a child event or duplicates a call already
observed at ingress; use call and parent-call IDs to make that relationship clear.
Subscription delivery and the activity publisher itself are infrastructure traffic
and need explicit exclusion, or logging creates an append/callback feedback loop.

Cross-post through trusted connection/platform plumbing. A project context remains
project-confined and receives no global-user handle or ambient Session grant for
this purpose. An alarm or autonomous processor is runtime activity; do not label
it as a current human call merely because a user originally caused the work.
Where known, retain its initiating event separately from its executing identity.

### Event contents and delivery semantics

A small proposed record contains call ID, parent/causation ID, verified principal,
non-secret credential/client/session identifiers, target coordinates, operation,
start/end time, outcome and duration. Use allowlisted summaries rather than raw
arguments or full expressions: literals can contain tokens, and request objects,
callbacks and capability stubs are not ordinary serializable data.

The existing stream supports ephemeral events. An ephemeral-only append does not
persist stream rows or advance the durable high-water mark. Its offsets are only
unique within a live incarnation. Processors must explicitly name consumed
ephemeral event types; the normal `*` subscription does not include them.

These events can disappear on eviction, disconnect or overload. They cannot
provide durable history, replay, or a promise that a user saw every call. Copies
sent to target and principal streams are not atomic; correlate them by call ID.
Keep authentication/credential facts and accepted command histories durable as
described above. A durable principal audit projection is a different requirement.

Ephemeral does not mean free: cross-posting adds RPC traffic, payloads, fan-out,
subscriber work, and potentially DO wakes or alarm activity. Use bounded batching
and queues with visible drop/failure counters; do not introduce unbounded logging
work or make ordinary API latency depend on both activity sinks. Missing feed
events must never be presented as proof that no operation occurred.

An account activity view must also respect the viewing credential's reach. A
project-A app must not learn about project B by reading the same user's aggregate
feed. This applies to live delivery and any subsequently persisted projection.

## Implementation sequence

1. **Foundation:** real global user context, authenticated Session, durable
   authentication fact, account processor, shared React/live state and reconnect.
2. **Account token workflow:** mint/revoke commands, readable results, recoverable
   issuer effects and the token page.
3. **All sessions and consent:** durable lifecycle publication, inventory
   reconciliation and the remaining session UI.
4. **Organizations and project creation:** domain contracts, recoverable directory
   mutations and live views, retaining D1 authority initially.

Each slice must prove its durable delivery and authorization boundaries before
the next adds effects. The optional activity feed can be evaluated separately.
The following tables describe the code changes and cost of each slice.

## Concrete code changes and estimates

All paths in this section are relative to `packages/v3/project-worker` unless
qualified. These are rough engineering estimates from the current source, not
measured future diffs or a delivery-time promise. Count each added or substantially
rewritten handwritten line once per phase, including nearby types and comments.
Tests are separate. Pure moves, generated SDK output, lockfiles, documentation,
and deleted code are excluded; the totals are **not net added LOC**. Later phases
may revise foundation code, so the combined total represents implementation work,
not the final size of a new subsystem.

### Existing pieces to reuse

| Existing code                                                                                                                               | Current size / useful boundary                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| [`src/session.ts`](../src/session.ts) / [`src/rpc.ts`](../src/rpc.ts)                                                                       | 298 / 150 lines; Session catalogs, RPC admission and live authorization lease                                  |
| [`src/iterate-context.ts`](../src/iterate-context.ts) / [`src/iterate-context-durable-object.ts`](../src/iterate-context-durable-object.ts) | 564 / 1,038 lines; context capabilities, name codec, host and durable delivery                                 |
| [`src/context/built-ins.ts`](../src/context/built-ins.ts)                                                                                   | 401 lines; physical operations and project-scoped bindings                                                     |
| [`src/client/live-state.ts`](../src/client/live-state.ts) / [`src/client/demo.tsx`](../src/client/demo.tsx)                                 | 214-line store plus roughly 80 lines of hook logic to extract; the demo does not implement automatic reconnect |
| [`src/client/browser.ts`](../src/client/browser.ts) / [`src/client/app-auth.ts`](../src/client/app-auth.ts)                                 | 64 / 197 lines; connection and per-origin authentication adapters                                              |
| [`src/grants.ts`](../src/grants.ts) / [`src/directory.ts`](../src/directory.ts)                                                             | 212 / 255 lines; existing issuer and directory effects to move behind domain workflows                         |

These are whole-file source line counts at planning time, including comments and
blank lines. They establish the scale of the existing implementation, not a plan
to rewrite those files. The stream contract, processor engine, replay, checkpoint,
subscription and live-state implementations already exist.

### Phase 1: foundation

Proposed new module names below describe responsibilities; they are not existing
files or a requirement to introduce one file for each row.

| Work                                                | Concrete implementation change                                                                                                                                                                                                                                                                                                                   | Implementation LOC |    Test LOC |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -----------------: | ----------: |
| Global coordinates and bootstrap                    | Update the name codec and context types in `src/iterate-context.ts`, DO setup, stream identity/`whoami`, loader and binding assumptions. Preserve project encodings; reserve the global encoding and install the platform-owned account processor durably.                                                                                       |             80–140 |      60–100 |
| Global context access                               | Add a small policy module, e.g. `src/account/context-access.ts`, enforced at context admission and physical operation dispatch. Preserve subject/path, command/fact, read/facet and returned-capability restrictions; partition or refuse project-only bindings globally. Cover aliases and rewrites without adding project-selection built-ins. |            140–240 |     120–220 |
| Session and public bootstrap                        | Update `src/session.ts`, `src/rpc.ts`, `src/principal.ts`, client auth/browser adapters and `src/types.ts` exports for `IterateRpcTarget.authenticate → SessionRpcTarget`, direct SDK return and `.user`. Reuse verification and lease ownership; retain project catalogs and existing API/MCP checks.                                           |             90–160 |      90–160 |
| Account contract, processor and authentication fact | Add `src/account/contract.ts` and `src/account/processor.ts` using the existing engine and live-state producer. Define explicit account birth, trusted successful-authentication facts, deduplication by operation, and a minimal account/activity view. Publish the fact durably before returning a human Session.                              |            140–230 |     100–180 |
| Shared React and connection lifecycle               | Extract the demo hook into a shared React entry, e.g. `src/client/react.tsx`; add the provider, `useIterateSession`, context selector retention/disposal, bounded reconnect, resubscription and reseeding. Update SDK/package exports and build entry wiring; retain the existing store and gap repair.                                          |            130–220 |      90–160 |
| Platform route isolation and first consumer         | Update `src/routes/-client.ts`, `_auth` routes and `src/client/dashboard-data.ts` to use the provider and a minimal account activity view. Let the directory render independently of per-project discovery. Keep one SPA and shared shell.                                                                                                       |             50–100 |       40–80 |
| **Foundation total**                                | **About 1,130–1,990 lines including tests.**                                                                                                                                                                                                                                                                                                     |      **630–1,090** | **500–900** |

The foundation proves a user can authenticate, obtain a real `.user` context,
observe that durable authentication fact through the shared React/live-state
interface in two tabs, and reconnect successfully. Project selection and project
alarms remain confined. Token mint/revoke effects and an organization application
are subsequent slices; the examples describe their eventual shared interface.

Use existing unit/workerd suites for context addressing, rewriting, Session doors,
control-plane authorization and processor delivery. Extend browser/API tests for
the changed bootstrap, second-tab updates and reconnect; do not create a parallel
test harness. Most of the 80-line hook extraction is a move and is excluded from
the implementation estimate.

Confidence is medium. The largest uncertainties are enforcing global privacy
through every generic context operation and fitting the explicit RPC bootstrap to
the existing cookie adapter. The range assumes a small shared policy/dispatch seam,
not a replacement resolver, authorization system or processor framework.

### Subsequent domain phases

| Phase                                 | Concrete implementation change                                                                                                                                                                                                                                                                                                                          | Implementation LOC |        Test LOC |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -----------------: | --------------: |
| 2. Account token workflow             | Extend the account contract/processor with mint/revoke operations and readable results. Move domain orchestration out of `src/grants.ts` behind a narrow issuer adapter; add stable operation identity, uncertain-outcome reconciliation and bounded cleanup. Convert the token portion of `src/routes/_auth/sessions.tsx` to commands plus live state. |            450–800 |         350–650 |
| 3. All sessions and consent           | Publish lifecycle outcomes from `src/browser-session.ts`, `src/issuer-session.ts`, `src/oauth.ts`, `src/consent.ts` and grant operations. Add durable obligations/reconciliation for interrupted publication, paginated inventory import and the remaining session-page live views.                                                                     |            250–450 |         200–350 |
| 4. Organizations and project creation | Add organization contracts/processors and Session organization selection. Route existing `src/directory.ts` mutations through recoverable commands while retaining D1 authority, atomic owner creation and slug uniqueness. Add organization/project-directory live views and idempotent cross-context publication.                                     |            200–350 |         150–250 |
| **Phases 1–4 combined**               | **About 2,730–4,840 lines including tests.**                                                                                                                                                                                                                                                                                                            |    **1,530–2,690** | **1,200–2,150** |

Each phase removes its superseded direct mutation and manual refresh path as it
lands. Existing issuer protocol code stays in place. The token estimate has the
lowest confidence: provider issuance is not idempotent, and a provider success
followed by failed context settlement needs proof, not another blind retry.
Provider callbacks that run before a write commits cannot publish a successful
issuance fact as though the credential already exists.

### Optional activity-feed increment

These costs are additional to the main phases and are not included in their
totals. The rows are incremental: the first alone does not meet “every call.”

| Work                                                                                                                                           | Implementation LOC |    Test LOC |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | -----------------: | ----------: |
| Context invocation plus local Cap’n Web dispatch, correlation/redaction, bounded trusted publisher and target/principal ephemeral sinks        |            250–450 |     150–250 |
| Close the forwarded/native/returned-capability coverage gaps; verify ordering and callback exclusions, potentially changing the Cap’n Web fork |            200–400 |     200–400 |
| Account/context live activity UI using the shared live-state interface                                                                         |            120–200 |      60–100 |
| **Optional feed total**                                                                                                                        |      **570–1,050** | **410–750** |

That is approximately **980–1,800 additional lines including tests**, with low
confidence until the forwarding boundaries are prototyped. A durable all-operation
audit index or historical analytics is not included in this ephemeral-feed estimate.

### Parked or outside these estimates

- **Session modeled as a context:** parked. Keep the handwritten Session. Direct
  principal-context authentication, `session.user.projects`, project-selection
  built-ins and per-invocation cross-project grant propagation are not planned.
- **Service identity expansion:** `/principals/service-admin` is the reserved
  proposed identity/audit path when needed. Its context/UI, named service accounts,
  credential inventory and delegation are not foundation requirements.
- **Custom-domain registration and lookup:** the grant ceiling and common Session
  behavior are specified above; domain ownership verification, DNS/certificates,
  registration UI and issuer mapping integration need their own scoped plan.
- **Separate applications or deployments:** retain one SPA now. Separate bundle,
  origin and deployment work can follow without changing the API model. Migrating
  the apps/os repo/agent dashboard wholesale is not counted here.
- **D1 becoming only an index:** possible later, but requires an explicit authority
  and consistency migration. It is not hidden inside global-context plumbing.
- **A durable principal-wide audit of every operation:** retain the attribution
  design and durable domain facts; exhaustive audited reads/denials and cross-domain
  aggregation are separate scope. Ephemeral activity does not satisfy that scope.
- **A new event engine, processor registry or generic privileged worker framework:**
  unnecessary. Reuse the current kernel and add only the required trusted adapters.

## Acceptance proof

For the foundation:

- Browser and personal-token authentication identify the same user context with
  their respective permissions. Each successful authentication records one
  durable fact before its Session is returned; publication retries deduplicate.
  Clients cannot forge success facts, and failed unverified login claims do not
  become authenticated user actions.
- Two authorized tabs observe the account projection. Reconnect, resubscription,
  revision gaps and DO eviction converge without leaking subscriptions. Platform
  directory rendering does not wait for project app discovery.
- Foreign accounts, reserved-project access, forged facts and insufficient scopes
  are refused through ordinary calls, physical built-ins, aliases, raw history,
  snapshots, subscriptions and returned capabilities. Global storage bindings do
  not accidentally share private data.
- A project cannot select another project through dotted calls, `invoke`,
  `builtins`, rewriting, a loaded worker or an alarm, including after an admin call.
  The originating Session can separately select each authorized project. No
  remembered caller grant is needed to run an alarm.
- Account birth and processor installation precede accepted commands; a crash
  before first delivery still recovers through the durable subscription.

For the subsequent domain phases:

- Another authorized tab observes mint/revoke outcomes and can read retained
  personal-token values without reloading, subject to its own scope and ceiling.
- Revocation or membership removal between request and effect prevents issuance;
  expired intent never runs late. Provider cleanup failure remains visible with
  bounded recovery, and revoked authority is refused within the existing bound.
- Crashes before delivery, during issuance, after provider/database success and
  before context settlement have explicit outcomes. Replay never issues another
  credential; a lost browser response can recover a retained result.
- Session/consent publication recovers after interrupted delivery. Organization
  creation preserves atomic ownership; project creation preserves slug uniqueness.

Use focused unit and workerd tests plus browser/API/MCP compatibility checks as
appropriate to the slice. Operational acceptance additionally requires a preview
deployment with coherent traces, logs and resulting durable state. Investigate
every unexpected error and classify expected denials outside the error signal;
green tests alone are insufficient.

If the optional feed is built, verify the claimed call-coverage matrix, RPC
ordering, redaction, project-limited visibility, bounded overload/drop reporting,
and absence of publisher/subscriber feedback loops. Demonstrate and document loss
on reconnect/eviction instead of treating the feed as a durable audit trail.

## Review context

Fable independently favored reuse of the context kernel, per-user processors,
separate platform/project modules, and one live-state mechanism. Jonas's latest
scope decision keeps authentication and catalogs on a handwritten Session while
using real contexts for user/domain state. Direct principal-context authentication,
project-selection built-ins and per-invocation cross-project grants are parked.
Fable has not reviewed this latest interface.

Initial D1/provider authority remains a pragmatic starting point, not a permanent
storage requirement. Readable persisted tokens simplify reconnect/result delivery;
provider-write/context-commit recovery remains work for the token workflow slice.
