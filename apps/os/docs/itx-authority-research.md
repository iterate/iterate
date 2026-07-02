# itx authority research: does authority come from the CONTEXT or the USER?

> **Status: historical research report (pre-migration).** Researched against
> the PRE-itx-v4 itx layer, deleted in the itx-v4 replacement; code paths
> below refer to that implementation. The conclusions (authority at connect,
> narrowing as construction) carried into the current engine's auth adapter
> (`apps/os/src/next/auth.ts`).

Status: RESEARCH REPORT, 2026-06-11. Commissioned question, in spirit: "You
come to the edge with a cookie that resolves into scopes. The context is a
thing all users share, but they each might have different permissions. We
have to decide whether authority is derived from the CONTEXT (the itx
durable object) or from the USER that connects to it. Also: GuardCapability
seems pretty fucking complicated — find better options."

Companions: `itx-next.md` (esp. "The address unification" and its LOCKED
sections), `src/itx/itx.ts` / `handle.ts` /
`access.ts` / `entrypoint.ts` / `fetch.ts`, `DECISIONS.md` (D17),
`docs/domain-objects-and-stream-processors.md`.

---

## Executive summary

**The question is a false binary, and the literature says so on both
sides.** In every serious ocap system — Cap'n Proto, Sandstorm, E — the
answer is: _between objects_, authority is the reference you hold (pure
ocap); _at the human boundary_, a trusted edge translates identity into a
narrowed reference, and that translation is allowed to consult
identity-keyed data. Kenton's own two systems split exactly this way:
Cap'n Proto's restore is "itself a capability" whose realm "looks up the
token in a database, **verifies permissions**, and returns a live ref";
Sandstorm passes each user's permission bits (`X-Sandstorm-Permissions`)
into the shared grain on every request and lets the app enforce them.
capnweb's README recommends the same shape in miniature: an in-band
`authenticate()` method "that returns the authenticated API" — a
per-principal narrowed view minted at connect.

**For itx this means: the CONTEXT stays principal-free; the HANDLE becomes
the per-principal object.** The handle is already a server-side view minted
at the edge from the principal — it already carries `access`, it is already
the only door a connected client holds, and every dangerous operation
already flows through a handful of its chokepoints (`invoke`, the verbs,
`fetch`, `project`, `describe`, `shareUrl`). Per-principal permission =
a **path mask compiled from the principal at connect, enforced inside the
handle** — the classic ocap attenuating-facet/caretaker pattern (Redell
1974), implemented as ~30 lines and one pure function
`maskForPrincipal(principal, projectId) → PathMask`. No guard rows, no
per-user durable contexts, no kernel change: the `Itx` core never learns
what a principal is.

**GuardCapability should die.** Its complexity is not in the framing — it
is structural: (1) guard rows are attenuation-by-blocklist (anything newly
provided on the project context auto-appears in every narrowed view —
default-allow, the wrong fail mode); (2) the revocability paradox — the
narrowed handle holds `revokeCapability`, and revoking a guard resurfaces
the unguarded parent cap, so guards must be unrevocable-by-holder, a new
kernel concept; (3) "props are scope rules" is authority-by-content in
props, the exact thing Law 2 prohibits; (4) every guarded call pays a
double dispatch through a deputy that needs a full-authority handle on the
parent — a confused-deputy generator; (5) N users × M rules of durable
journal rows that silently drift when auth-side scopes change. The durable
narrowed-context mechanism (`extend` + provides) stays — for _state_, not
for _permissions_.

**What the kernel does need from the principal: attribution, not
authority.** The dial already injects `{capability, context, projectId}`;
it should also inject the principal (id + claims) so trusted first-party
providers can apply _resource-level_ policy (this stream, that repo) the
way Sandstorm grains do — and so journal events record _who_. The doctrine
line to hold: kernel and dispatch never consult the principal; only leaf
providers may, and only first-party ones. The deputy rule: a capability
calls with _its own_ authority (its home context), never with the authority
of whoever provided it; machine-initiated work (agents, processors, cron)
runs as the project/agent principal, never as "the last user who spoke."

**Recommendation in one sentence:** keep "restore is gated at the edge,
names carry zero authority" exactly as is; add a principal-compiled path
mask to `ItxRuntime` enforced at the handle's existing chokepoints (deny
masked paths as byte-identical NOT*FOUND); inject the principal as dial
attribution for first-party resource policy and journal actor records;
make the mask trivially `allow-all` until per-project roles exist in
tokens (they don't today — project claims are `{id, slug, organizationId}`,
no role); and delete `itx.narrow({scopes})`/GuardCapability from the
locked design. Until the auth system can even \_say* "Alice is read-only on
prj_X", the only honest implementation is the seam, not the policy.

What we give up, named honestly: no offline attenuation (a holder cannot
mint a narrower credential without the edge — Macaroons/Biscuit do this;
our pure-name posture deliberately doesn't); per-principal grants are not
journal rows (the audit trail of "who could do what when" lives in the
auth system + actor-stamped events, not in the context's journal); and the
mask is consulted per call on the handle — identity-derived data on the
hot path, even though it is carried by the reference, not looked up per
resource. Those are the three sentences to disagree with.

---

## 1. Primary sources

### 1.1 Cap'n Proto, `persistent.capnp` (Kenton Varda)

The SturdyRef/save/restore model the itx docs already cite, with the parts
that matter for _authority_:

- "a SturdyRef can be stored to disk, then later used to obtain a new
  reference to the capability on a future connection." The format "depends
  on the 'realm'" — "an abstract space in which all SturdyRefs have the
  same format and refer to the same set of resources."
- Sealing: "SturdyRefs may be 'sealed' to a particular owner, such that if
  the SturdyRef itself leaks to a third party, that party cannot actually
  restore it because they are not the owner." And: "To restore a sealed
  capability, you must first prove to its host that you are the rightful
  owner."

That last sentence is the canonical blessing for identity at the restore
edge: even in the purest capability protocol Kenton wrote, _who you are_
may gate _what a name restores to_. itx already implements this ("restore
stays gated", itx-next.md, address unification §1) — the open question is
only whether the _result_ of a gated restore can differ per principal.
persistent.capnp's answer is yes: sealing is per-owner by design.

### 1.2 Kenton on the capnproto list (SturdyRef thread, `d6uPbXf9e4E`)

- "in each case the format of a SturdyRef and the procedure for restoring
  it is completely different, so much so that it doesn't appear that any
  'standard' definition makes sense."
- For Sandstorm grains: SturdyRefs are opaque tokens; the client passes
  them to the Sandstorm API, which "looks up the token in a database,
  **verifies permissions**, locates the target grain, and retrieves a live
  capability reference."

Restore = database lookup + permission check + live ref. The restorer is
explicitly allowed to be an ACL-ish component; what makes the system ocap
is that _after_ restore, authority flows only by reference.

### 1.3 Cloudflare Workers RPC blog (the ocap sections)

- "The User reference received by the client is a 'capability', because
  receiving it grants the client the ability to perform operations on the
  user." The client "cannot create a User object out of thin air, and
  cannot call methods of an object without first explicitly receiving a
  reference to it."
- The worked example is precisely our problem in miniature: an
  `AuthService` whose `authenticate(credential)` returns a `User` object —
  "The AuthService API does not provide any other way to obtain a User
  instance." Per-principal authority = per-principal _returned object_.
- "Capability-based security is often like this: security can be woven
  naturally into your APIs, rather than feel like an additional concern
  bolted on top."

### 1.4 capnweb README

- "object-capability RPC model"; `RpcTarget` instances pass by reference.
- On auth: "you generally cannot use cookies nor other headers for
  authentication. Instead, we highly recommend the pattern … in which
  authentication happens **in-band via an RPC method that returns the
  authenticated API**."

The transport itx is built on documents the A-shaped answer as its
recommended idiom: the authenticated, per-principal API object IS the
authority. Our `connectItx` does the cookie/token translation _before_ the
session instead of in-band, but the resulting `ItxHandle` plays the same
role: it is "the authenticated API," and there is nothing heretical about
that object being narrower for some principals than others.

### 1.5 Sandstorm (Kenton's shared-mutable-object platform)

Sandstorm is the closest prior art to "the context is a thing all users
share, but they each might have different permissions" — a _grain_ is a
shared mutable app instance, multiple users open it with different roles:

- The platform injects per-request identity and permissions into the
  grain: `X-Sandstorm-User-Id`, and `X-Sandstorm-Permissions` — "a list of
  the permissions held by the current user, joined with a comma such as
  `edit,admin`."
- Apps define permissions/roles (`PermissionDef`/`RoleDef`) and their
  meaning; "Sandstorm merely tracks who is allowed to access which grain
  with which permissions" — "permissions are computed on-the-fly every
  time the recipient of the share opens the grain."

So Kenton's own design for exactly our case is: ocap _between_ grains
(powerbox, SturdyRefs), **principal-carried permission bits at the grain
boundary**, enforcement inside the trusted app against data the platform
injected. Note two properties we should copy: permissions are _computed at
open time_ (no durable per-user permission rows to drift), and the
_platform_ computes them while the _app_ enforces them (split between a
generic mechanism and domain meaning).

### 1.6 Classic ocap literature

- **Capability Myths Demolished** (Miller, Yee, Shapiro 2003,
  srl.cs.jhu.edu/pubs/SRL2003-02.pdf): ACLs are the _columns_ of Lampson's
  access matrix (each resource lists principals), capabilities the _rows_
  (each subject holds refs). The myths: equivalence (they are NOT formally
  equivalent — caps fuse designation with authority and make authority
  flow analyzable), confinement (caps CAN confine), irrevocability (caps
  CAN be revoked — via the caretaker/revocable-forwarder pattern, "Redell
  described exactly this method for revoking access in 1974").
- **The Confused Deputy** (Hardy 1988): "The fundamental problem is that
  the compiler runs with authority stemming from two sources" — the
  invoker's and its own — with no way to keep them apart when a name
  arrives without authority attached. The fix: "The capability both
  identifies the file and authorizes the compiler to write there."
  This is the precise risk in Position B below.
- **E-lang patterns** (erights.org; site intermittently unreachable during
  this research, patterns cited from the Walnut "Capability Patterns"
  text): _facets_ (a narrow surface object onto a wider composite),
  _caretakers_ (revocable forwarders), _membranes_ (transitively wrap
  every ref crossing a boundary so revocation/attenuation is deep). The
  attenuated handle proposed below is a facet; if it ever needs to wrap
  refs it _returns_, that's the membrane extension.
- **Macaroons** (Birgisson et al., NDSS 2014): bearer tokens with
  chained-HMAC _caveats_ — "macaroons embed caveats that attenuate and
  contextually confine when, where, by who, and for what purpose a target
  service should authorize requests." Anyone holding a macaroon can mint a
  strictly weaker one offline. **Biscuit** (biscuitsec.org) is the
  public-key descendant (offline attenuation + Datalog checks). These are
  the "authority IS the ref's content" pole — the opposite of our
  pure-name posture, listed for the trade-off table, not adopted.

---

## 2. What the code does today (the baseline to be honest about)

Stated as the implementation actually is (`access.ts`, `handle.ts`,
`itx.ts`, `fetch.ts`, `refs.ts`, D17):

1. **Connect**: cookie/admin-secret → `Principal` → `accessForPrincipal` →
   `"all" | projectId[]`. The access set gates exactly three things:
   _which contexts you may connect to / narrow to_ (`projects.get`,
   `resolveAccessibleContextId`, existence-masked), _global streams_
   (`access === "all"`), and _project create/remove_.
2. **Inside a context, authority is binary.** A project handle's access is
   forced to `[projectId]` regardless of props (entrypoint.ts D7 rule).
   From there: every cap on the chain is callable, `provideCapability` /
   `revokeCapability` / `extend` / `invoke` are ambient on every handle,
   `itx.project` exposes the **whole Project DO surface** (D17, owner
   decision, verbatim rationale: _"you have the project or you don't"_),
   `itx.fetch` is egress **with secret substitution**, and `shareUrl`
   mints bearer tokens. Holding the context = root on the project.
3. **The principal is not on the handle.** `ItxRuntime` has
   `access`/`capabilityPath` but no principal; `itx-next.md §5` already
   decided the direction ("`ItxProps` carries the principal, not a
   precomputed access list") but it isn't built.
4. **Origin is attribution, not authority** — and the code defends that
   line explicitly: the handle never forwards `origin` ("that field is the
   chain's trusted identity channel, set by delegating NODES only"), and
   the `itx.project` proxy blocks `itx*`-prefixed plumbing because it
   "would let any handle holder spoof another context's identity."
5. **Tokens cannot express per-project roles.** `IterateAuthProjectClaim`
   is `{id, slug, organizationId}` — no role field. Org claims carry
   `member | admin | owner`. The #1418 access model ("admin sees all,
   users see their projects, ONE seam for finer-grained later") is the
   current design of record.

So today the answer to the owner's question is unambiguous: **authority is
derived from the context** (which handle you could mint), with the
principal consulted exactly once, at connect, to decide context
reachability. The question is what happens when two principals may hold
the _same_ context with _different_ permissions — which the current model
cannot express at all.

---

## 3. The fault line

Shared-mutable-object + per-principal permissions is the ocap-vs-ACL
tension in its classic form. The matrix framing (Capability Myths): we
have one _column_ (the project context) and want different _cells_ per
principal. ACL thinking puts the principal list on the column (the context
stores who-may-what). Cap thinking gives each principal a different _row_
(a different reference). Three coherent positions:

### Position A — pure ocap: authority IS the context you hold

Per-principal permission = per-principal narrowed contexts. The connect
edge doesn't hand everyone the project context; it hands each principal a
**view** — a child context (today: `extend`) whose chain ends at the
project, attenuated for that principal.

How the pieces would work:

- **Connect edge**: `connectItx` resolves `(principal, project)` → a
  deterministic per-user view context (minted lazily, reused across
  sessions), auto-narrowed from token scopes. Admins/full members get the
  project context itself; restricted principals get their view.
- **Attenuation mechanism**: the view shadows what the principal must not
  reach. This is where it goes wrong — see the GuardCapability critique
  (§4): shadowing is _subtractive_ (blocklist over a default-allow chain).
  The honest pure-A alternative is an _additive_ view: a context with NO
  parent link and explicit re-export provides for each granted cap — which
  forfeits live chain updates, makes describe() a stale copy, and turns
  every role change into a row-diff migration.
- **Proliferation & GC**: one durable context per (principal, project)
  that ever connected. The locked "everything durable + idle-TTL +
  facet-of-the-Project-DO" design makes this _affordable_ (in-process
  chain hop, cascade delete), but it is real state: journals, birth
  certificates, TTL alarms — for what is conceptually a pure function of
  the token.
- **describe()**: each principal sees their view's chain — correct and
  agent-friendly (describe = what you can actually call). But provenance
  now leaks structure: a guard-shaped view tells the user exactly what was
  withheld; an additive view hides it (existence masking preserved).
- **Shared LIVE provides**: a `fetch` shadow provided on the _project_
  context is inherited by every view (chain) — the "meant for everyone"
  semantics survive. But note the inversion: providing on the project
  context is now an _elevated_ act (it affects other principals'
  traffic), so A still needs _something_ to gate who may provide where —
  i.e. A does not eliminate per-principal checks, it relocates exactly one
  of them (write-to-shared-context) and that one still needs the
  principal.
- **Chain cost**: +1 hop per non-shadowed call; in-process if views are
  facets of the Project DO. Negligible.
- **Revocation / role change**: the view must be _rebuilt_ when auth-side
  scopes change. Durable views minted from a token at time T silently
  drift from the auth system at time T+1 — the same drift class as
  preview OAuth secrets. Mitigation: recompute guards at every connect
  (Sandstorm: "computed on-the-fly every time… opens the grain") — at
  which point the durable rows are a cache of a pure function, and you
  should ask why they are rows at all.
- **Agents/isolates**: a project-owned worker's bare fetch carries
  `{projectId, context}` — no user. Under A this is naturally fine: the
  worker's home context IS its authority (the project context or an agent
  session), no principal needed. A's cleanest property.
- **Multi-user same project, different roles**: works by construction —
  different views.

Verdict on A: doctrinally pure, mechanically already half-built
(`extend`), and the right shape for _stateful_ per-user things (a user's
session scratchpad, an agent run). As the _permission_ mechanism it makes
durable state out of a pure function and inherits either default-allow
(subtractive) or staleness (additive). The literature does not actually
demand it: Kenton's restore-edge "verifies permissions" and Sandstorm's
computed-at-open permissions both bless ephemeral, identity-derived
narrowing at the boundary.

### Position B — principal-carried authority: every call carries who

The origin channel exists (`itxInvoke({ origin })`, dial-injected
attribution props); B promotes it: calls carry `{principal, scopes}`, and
enforcement happens at the node's dispatch (capability-path granularity)
and/or inside providers via injected props (resource granularity).

- **Where checks live**: either in `Itx.invoke` (the kernel grows a policy
  engine keyed by identity — kernel innocence dead, 500-line goal dead),
  or scattered across providers (the pre-itx world the Laws were written
  to kill: "Root*/Project* capability triples' duplicated
  assertNamespaceAccess" is in the spec's deletion table as a trophy).
- **The doctrine cost**: Law 3 ("Code holding an itx never checks scopes,
  because scopes don't exist") inverts into "everything checks scopes."
  Names start carrying implied authority again ("this path is allowed for
  role X") — "capabilities grant, names don't" dies not at the edge but
  everywhere.
- **Confused deputy, concretely**: capability P (provided by admin Alice)
  is called by restricted Bob; P internally calls `itx.streams.append`.
  Whose authority? If Bob's principal propagates: P breaks for Bob even
  when P's _purpose_ is to do privileged things safely on Bob's behalf
  (the deputy is supposed to use its own license for the billing file);
  every cap author must now reason about every caller's role. If P's
  (or its provider's) principal is used instead: any callable cap is a
  privilege-escalation gadget (Bob reaches the database through P), and
  P "runs with authority stemming from two sources" — Hardy's exact
  trap, rebuilt on purpose. There is no third option; this fork is
  intrinsic to identity-carried authority.
- **Fetch middleware**: per-project interception still works (the shadow
  is a cap), but now the shadow _provider_ must decide which principals'
  traffic it may see — secret-placeholder traffic from an admin flowing
  through a shadow provided by a non-admin is a policy question B forces
  on every provider.
- **Agents/isolates**: the fatal hole. A processor wake, a cron'd agent
  turn, a stream subscriber — _there is no user_. B needs a machine
  principal ("the project", "the agent"), and since most calls in an
  agent-native system are machine-initiated, most calls run as the
  most-privileged local principal anyway. B's per-principal enforcement
  then only bites on the human-edge calls — which is exactly where the
  edge already sits. B collapses, under load, into "edge enforcement plus
  ambient machine authority" — the current model with extra plumbing.
- **Revocation**: B's one genuine win — change the row in the auth DB and
  the very next call sees it. No views to rebuild, no token staleness
  beyond the session.
- **Is it just ACLs with extra steps?** At dispatch granularity, yes,
  definitionally: an identity-keyed lookup per resource access, the
  matrix-by-columns. The honest version of B for this codebase is not
  "carry authority on every hop" but its resource-granularity remnant:
  _trusted leaf providers may consult injected principal data_ — which is
  Sandstorm's split, and survives into the recommendation.

### Position C — hybrids worth naming

**C1. Edge auto-narrowing — attenuated handles (B's ergonomics, A's
mechanism).** The connect edge compiles the principal's scopes into data
carried by the HANDLE, and the handle's own server-side methods enforce
it. No durable views, no per-hop principal, no kernel change. This is the
ocap facet/caretaker executed at the one boundary that already exists. In
capnweb-membrane terms: the handle is the membrane's single facet; because
itx flattens dotted paths into data and funnels every dynamic call through
`invoke`, the membrane needs no transitive wrapping — there are ~6
chokepoints total (`invoke`/fallthrough, the verbs, `fetch`, `project`,
`streams`(global), `shareUrl`, `describe`). Detailed as ALT 1 in §4.

- Deputy-safe: attenuation lives at the human's reference; once a call
  crosses into a cap, the cap runs with its home context's authority —
  deputies keep one authority source.
- Revocation: handle dies with the session; reconnect re-derives. Live
  long-lived sessions can re-check cheaply (the mask is in memory; the
  edge can refresh it on token refresh).
- Cost: identity-derived data evaluated per call on the handle. It is
  _carried by the reference_ (row, not column) — but a purist will
  correctly observe it was _derived from identity_ one hop earlier. So
  was the access set; so is every authenticate() return in Kenton's blog
  example. This is where "ocap vs ACL" stops being a real distinction.

**C2. Per-principal views as ordinary extends, guards as ordinary
provides written by an edge library** (the GuardCapability steelman —
"is the complexity in the concept or the framing?"). Evaluated in §4:
the framing is fixable (an edge library CAN write plain provides), but
three problems are conceptual, not presentational: default-allow
subtraction, the revocability paradox, and scope drift in durable rows.
The concept survives only where the view needs _state_.

**C3. Sealed/caveated sturdy refs (Macaroons/Biscuit-style).** Make refs
carry caveats; holders attenuate offline ("only path prefix /reports",
"expires in 1h") and hand the narrower ref to a sub-agent without asking
the platform. What we'd give up: the pure-name posture (Law 2's
"zero authority by content" — refs become bearer credentials that must be
treated as secrets), revocation (bearer tokens revoke badly; Macaroons
need revocation caveats/short TTLs), and key discipline. What we'd gain
is real: _offline sub-delegation_, the one thing no server-side design
provides — an agent spawning a sub-agent with a strictly weaker itx,
without a round-trip. Position: keep bearer form at the HTTP edge only
(the share token IS a one-caveat macaroon: `project:cap:expiry`, HMAC —
already documented as a sealed SturdyRef); if offline attenuation is ever
needed, add caveats to the share token rather than re-platforming refs.

### Trade-off table

|                                              | A: per-principal view contexts                    | B: principal on every call                       | C1: edge-compiled attenuated handle                               | C3: caveated refs                  |
| -------------------------------------------- | ------------------------------------------------- | ------------------------------------------------ | ----------------------------------------------------------------- | ---------------------------------- |
| Kernel innocence (Itx knows no principals)   | yes                                               | no (dispatch checks) / partial (provider checks) | **yes** (handle-only)                                             | yes (verifier at edge)             |
| "Capabilities grant, names don't"            | preserved                                         | inverted                                         | preserved (the handle IS the grant)                               | weakened (content grants)          |
| Confused deputy                              | safe                                              | the fork is intrinsic                            | safe (attenuate the ref, not the flow)                            | safe-ish (caveats travel with ref) |
| Multi-user / multi-role same project         | by construction                                   | by construction                                  | by construction                                                   | by construction                    |
| Machine-initiated calls (agents, processors) | clean (home context = authority)                  | needs machine principals; degrades to ambient    | clean (isolate handles get project-authority masks)               | clean                              |
| Fetch middleware: per-project shadow         | inherited via chain; _providing_ needs a gate     | provider must reason about principals            | inherited; provide-verb is masked per principal                   | n/a                                |
| Fetch middleware: per-user shadow            | own view (exists today: extend)                   | hard (shadows are context-level)                 | own extend (exists today)                                         | n/a                                |
| Revocation latency                           | rebuild views (drift risk)                        | **immediate**                                    | session-bounded; re-derive on reconnect/refresh                   | bad (bearer)                       |
| Offline attenuation / sub-delegation         | no                                                | no                                               | no                                                                | **yes**                            |
| Journal auditability of grants               | grants are rows (auditable, but drifting)         | grants live in auth DB                           | grants derived; journal records _actor_, auth DB records _policy_ | token chain                        |
| describe() coherence                         | per-view, fresh (subtractive) or stale (additive) | full table + per-call surprises                  | **filtered per handle, always fresh**                             | n/a                                |
| State cost                                   | context per (user, project)                       | none                                             | none                                                              | none                               |
| Lines of code / 500-line goal                | extend exists; guard machinery large              | policy engine in kernel or scattered             | **~30 lines + 1 pure function**                                   | new token infra                    |

---

## 4. GuardCapability: critique, and two-plus simpler designs

The locked sketch (itx-next.md, "Locked in review (2026-06-11 evening)"):
`itx.narrow({ scopes })` = handle sugar (~15 lines) that extends a child
context and provides **GuardCapability rows whose PROPS are the scope
rules**; address-shaped guards make the narrowed context durable and
addressable.

### Why it is actually complicated (not just framed badly)

1. **Default-allow.** Guards shadow paths; everything unguarded falls
   through the chain. A cap provided on the project context _tomorrow_
   appears in every previously-narrowed view _today_. Permission systems
   must fail closed; shadowing-attenuation fails open. To fail closed you
   must enumerate-and-guard the whole surface — at which point you have
   written an allowlist, in the most expensive encoding available.
2. **The revocability paradox.** The narrowed handle carries
   `revokeCapability` (every handle does). Revoking a guard row
   resurfaces the parent's unguarded cap — self-escalation in one call.
   So guards need "unrevocable by the context's own holder" — but
   "holder" vs "grantor" is a _principal_ distinction, which the kernel
   would now need to model. The design smuggles principals into the
   kernel through the back door while claiming kernel innocence.
3. **Law 2 violation by its own admission.** "PROPS are the scope rules
   (policy as data, Law 2)" — but Law 2 says props carry _identity_,
   never composition or authority-by-content. Scope rules in props are
   authority-by-content, period. The parenthetical cites the law it
   breaks.
4. **A deputy per guard.** A guard intercepts `["streams"]` and must
   forward allowed calls onward — with what? A full-authority handle on
   the parent context (or the trusted-origin channel). Every guard is a
   privilege-holding deputy evaluating caller-supplied paths against
   rules in its props. That is precisely the code shape Hardy warns
   about, multiplied by the number of guarded prefixes.
5. **Drift + volume.** Scopes live in the auth system and change; guard
   rows are journaled context state and don't. N principals × M rules ×
   role churn = a reconciliation job nobody asked for.
6. **Double dispatch.** Guarded hot paths (streams!) pay guard-dial +
   re-dial on every call.

The _durable narrowed context_ half of the idea is good and already
exists (`extend`); the _guards-as-provides_ half is the problem.

### ALT 1 — "the scope IS the path": principal-compiled path mask on the handle

One pure function, no guard entries at all.

```ts
// refs.ts / access.ts — pure data, computed at connect (and at restore
// for isolate handles, from the props-carried principal):
type PathMask =
  | { mode: "all" }                                  // today's behavior
  | { mode: "paths"; allow: string[][]; deny?: string[][] };  // prefix sets

// ONE pure function, the finer-grained seam #1418 reserved:
function maskForPrincipal(principal: ItxPrincipal, projectId: string): PathMask;

// ItxRuntime gains it (live value, never serialized; the serialized form
// is the principal itself, per types.ts's existing position):
type ItxRuntime = { access; principal; mask; ... };
```

Enforcement at the handle's existing chokepoints, longest-prefix, deny
masked paths as byte-identical NOT_FOUND (existence masking, D18):

```ts
// handle.ts — the entire mechanism:
#assertPath(path: string[]): void {
  if (!maskAllows(this.#runtime.mask, path)) throw notFoundForPath(path);
}
// called from: invoke(), capability() terminal call, fetch() (path
// ["fetch"]), project getter (path ["project", ...call.path]), the verbs
// (paths ["provideCapability"], ["revokeCapability"], ["extend"],
// ["shareUrl"]), streams (["streams", ...]); describe() filters by mask.
```

Call path: `connect → principal → maskForPrincipal → ItxHandle(mask)`;
isolates: `restorer → props.principal → same function → handle(mask)`.
The verbs being ordinary maskable paths is the payoff: "read-only handle"
= deny `provideCapability|revokeCapability|extend|shareUrl|project`,
~one line of policy. Scoring:

- _Kernel innocence_: total — `Itx` (the DO core) unchanged; the mask
  lives and dies in the handle, which is already the principal-shaped
  layer (it carries `access` today).
- _Auditability_: grants are not journal rows; compensate by stamping
  journal events with the actor (ALT 2's injection). "Who could do what
  when" = auth system history + actor-stamped events. Weaker than rows,
  honest about where policy actually lives.
- _Revocation_: session-bounded; re-derived every connect/restore. For
  long-lived sessions, refresh the mask when the edge re-validates the
  token (machinery the session layer needs anyway).
- _Offline attenuation_: none. Sugar `itx.withMask(narrower)` (intersect,
  monotone — can only shrink) gives _online_ self-attenuation for free:
  hand a sub-agent a weaker handle in-process, the caretaker pattern in
  one method.
- _500-line goal_: ~30 lines + the pure function + tests.

Weakness to name: masks speak _capability-path_ granularity. "May read
stream /a but not /b" does not belong in the mask grammar — resist
growing a policy language here; resource granularity is ALT 2's job.

### ALT 2 — provider-side enforcement via dial-injected principal props

The dial already injects `{capability/capabilityPath, context, projectId}`
as trusted, never-provider-supplied props. Add the principal:

```ts
// durable-itx.ts dial, alongside existing injection:
props: { ...entry.address.props, capabilityPath, context: origin,
         projectId, principal: { userId, isAdmin, orgRole } }
```

First-party providers that own _resources_ (StreamsCapability,
ReposCapability, WorkspaceCapability, EgressPipe policy verdicts) may
consult it for resource-level rules — Sandstorm's `X-Sandstorm-Permissions`
verbatim: platform computes and injects; the trusted leaf enforces domain
meaning. Doctrine lines that keep this from becoming B:

- The kernel and dispatch never read it. Only dial-injection writes it.
- Only first-party (allowlisted-loopback) providers may _enforce_ on it;
  for everything else it is attribution (journal actor, egress logs,
  billing).
- The deputy rule, stated once: a capability executes with **its home
  context's authority**; the injected principal identifies the
  _originating_ human (rides the same trusted channel as `origin`) and a
  provider may _restrict_ on it, never _amplify_ by it. Machine-initiated
  work (processor wakes, cron, agent turns) carries the machine principal
  `{type: "project" | "agent", id}` — never the last human who spoke.

This also fixes the audit gap: every `capability-provided` /
`script-execution-requested` journal event gains an actor.

### ALT 3 — per-principal views as ordinary extends (state, not permissions)

Keep the durable-narrowed-context mechanism for what it is good at: a
user's session context, an agent run, a demo sandbox — places that need
_their own provides_ (state), where `extend` + ordinary provides already
work and the edge can mint/reuse one per (user, project) when a feature
wants it. Combined with ALT 1, the view's _handle_ carries the mask;
the view's _rows_ carry its state. No guard rows ever; the addressable
narrowed credential the locked design wanted ("its id IS the sturdy ref")
still exists when needed — restore stays gated, and the restored handle's
mask comes from the restoring principal, not from rows.

### Evaluation

|                     | GuardCapability (locked)                | ALT 1: path mask               | ALT 2: principal props                             | ALT 3: views as extends   |
| ------------------- | --------------------------------------- | ------------------------------ | -------------------------------------------------- | ------------------------- |
| Kernel innocence    | claimed; broken by revocability paradox | yes                            | yes (kernel never reads)                           | yes                       |
| Fail mode           | open (default-allow chain)              | **closed** (allowlist compile) | provider-defined                                   | open if subtractive       |
| Granularity         | path                                    | path                           | **resource**                                       | whatever its provides say |
| Journal/audit       | rows (drifting)                         | actor-stamped events           | **actor-stamped events**                           | rows (state, not policy)  |
| Revocation          | row surgery + paradox                   | session re-derive              | immediate (provider reads live claims if it wants) | row surgery               |
| Offline attenuation | no                                      | no (online `withMask` only)    | no                                                 | no                        |
| Deputy risk         | one deputy per guard                    | none new                       | none if amplify-ban holds                          | none new                  |
| 500-line goal       | hostile                                 | **~30 lines**                  | ~10 lines                                          | already built             |
| Hot-path cost       | double dispatch                         | in-memory prefix check         | none (props ride existing dial)                    | +1 in-process hop         |

The complexity of GuardCapability was in the concept (items 1, 2, 4, 5),
not the framing. ALT 1 + ALT 2 + ALT 3 together cover everything
`narrow({scopes})` promised, with no new kernel concepts.

---

## 5. Seams inventory — where the current design silently assumes one model

Each of these is a place the code or docs assume context-holding = full
authority (or quietly pre-built the other model's channel):

1. **D17, the whole-surface posture** — `itx.project` returns the entire
   Project DO surface; rationale on record: "you have the project or you
   don't." This is the sentence the owner's new question reopens. Under
   any per-principal design, `project.*` must be a maskable path (ALT 1
   covers it; the proxy chokepoint already exists and already blocks
   `itx*`/`fetch`/`egressFetch`).
2. **Ambient kernel verbs** — every handle gets `provideCapability` /
   `revokeCapability` / `extend` / `invoke` / `shareUrl`. There is no
   read-only handle today. (The verbs-as-maskable-paths move fixes this
   without changing the verb surface.)
3. **`access` is context-selection authority only** — consulted for
   narrowing, global streams, create/remove; constant `[projectId]`
   inside a project. The in-context binary assumption lives here.
4. **Origin is attribution-not-authority, defended in code** — handle
   refuses to forward `origin`; `itx.project` proxy blocks identity-
   spoofing plumbing. B would promote this channel; the comments say
   don't. (Good seam — the trusted channel ALT 2 needs already exists
   and is already write-protected.)
5. **Live provides affect ALL holders** — a `fetch` shadow provided by
   one user intercepts every principal's egress (placeholders unsubstituted
   — by design the shadow never sees secrets, which limits the blast
   radius, but traffic _shape_ is visible). §9's open question ("apply to
   ALL callers or only the providing session?") is this seam by another
   name. Per-principal answer: providing on the shared context is itself
   a masked verb; per-session interception = provide on your own extend
   (already the locked `extend`-shadowing story).
6. **`ItxProps.access` on global handles** — authority-shaped data riding
   props, the one existing exception to "props carry identity"; project
   handles force-override it (D7 rule). The queued "dial props grow an
   `access` field" item would widen this exception — prefer carrying the
   _principal_ (identity) and deriving, per types.ts's own position.
7. **`describe()` shows the whole chain to any holder** — fine when
   binary; under per-principal it leaks the cap inventory (including
   guard/withheld structure) to restricted users. Mask-filtered describe
   keeps existence masking coherent.
8. **`shareUrl` mintable by any handle holder** — minting a bearer
   credential (the one sealed-SturdyRef exception) is an _authority_ and
   today requires nothing beyond holding the context. Should be a masked
   verb.
9. **`/api/itx/run` scripts inherit the context's full authority** — the
   runner handle has no principal today; the isolate's `env.ITERATE`
   props carry only `{context}`. types.ts's "ItxProps carries the
   principal" position is the fix (restore → mask), but it is unbuilt —
   right now a restricted member who can run a script IS project-root for
   the script's duration.
10. **Machine principals don't exist** — processor wakes, agent turns,
    and stream subscribers dial with no actor at all; events record no
    "who." Any per-principal future needs `{type: "project"|"agent", id}`
    actors before human roles mean anything (otherwise the agent is a
    universal laundering deputy: ask the agent to do what you may not).
11. **Tokens cannot say per-project roles** — `IterateAuthProjectClaim`
    has no role field; only org roles (`member|admin|owner`) exist. The
    auth system must grow per-project roles (or a deliberate org-role
    inheritance rule) before ANY of A/B/C is implementable as policy.
    This is the real critical path, and it is outside itx.
12. **Child-context access is owning-project-binary** —
    `resolveAccessibleContextId`: reachable iff the project is. Two users
    of one project can always open each other's session contexts (and
    their workspaces). Fine today; named assumption under per-principal.
13. **The journal records no actor** — `capability-provided` etc. carry
    payload but not who. Wave (f) is the natural moment to add actor
    stamping (ALT 2), since events become the only writes.
14. **`connectItx` is one-shot, no re-auth** — a session minted before a
    role downgrade keeps its authority until disconnect. Any
    session-carried permission data (mask or access) shares this
    staleness window; the reconnect loop work should include re-derive.

---

## 6. Recommendation

**Adopt C1 + ALT 2 + ALT 3; delete GuardCapability; sequence behind the
auth system's ability to express per-project roles.**

Concretely, in order:

1. **Now (doctrine, zero code):** amend itx-next.md's locked section:
   `itx.narrow({scopes})`/GuardCapability is replaced by the
   principal-compiled path mask. Write the deputy rule and the machine-
   principal rule into the Laws (a capability runs with its home
   context's authority; injected principal restricts, never amplifies;
   machine work carries machine actors). Record D17 as superseded-when-
   masks-land: "you have the project or you don't" becomes "your handle
   has the path or it doesn't."
2. **Wave (f) rider (small):** dial-injected `principal` attribution +
   actor-stamped journal events (ALT 2's plumbing, attribution-only at
   first). This is days, not weeks, and pays for itself in audit alone.
3. **The seam made real (small):** `ItxRuntime.principal` +
   `ItxRuntime.mask` + `maskForPrincipal` returning `{mode:"all"}` for
   every current principal — zero behavior change, all chokepoints wired,
   tests assert the chokepoint inventory so new handle surface can't
   bypass it. `itx.withMask(intersect)` sugar for online self-attenuation.
4. **Blocked on auth:** per-project role claims. Until then any richer
   `maskForPrincipal` is fiction.
5. **Never (unless a feature demands offline sub-delegation):** caveated
   bearer refs. If demanded, extend the share token (it is already a
   one-caveat macaroon) — do not re-platform context refs.

Why this and not pure A: per-principal _permissions_ are a pure function
of (principal, project) — the auth system owns that function's inputs and
its history. Materializing it as durable context rows buys addressability
we don't need (restore is already gated and can mask at restore time) at
the price of drift, GC, default-allow-or-staleness, and the revocability
paradox. Per-principal _state_ is a different thing and keeps the
`extend` mechanism it already has.

Why this and not pure B: the deputy fork is intrinsic, the kernel loses
innocence, and in an agent-native system most calls are machine-initiated
— B degrades to edge-enforcement-plus-ambient-machine-authority while
charging every provider author a per-call identity tax. B's one genuine
advantage (instant revocation) is recovered well enough by
session-bounded masks plus re-derive-on-refresh.

Why this is still ocap and not "ACLs with extra steps": the check is
carried by the _reference_ (the handle the edge minted for you — a row),
not looked up per-resource against a principal list (a column). The
context — the shared durable object — never stores or consults who.
Attenuation composes the ocap way (`withMask` intersects; extends
narrow); delegation is handing someone a handle, not editing a list. The
one identity-keyed lookup in the system remains where Kenton put it in
every realm he built: at restore. "To restore a sealed capability, you
must first prove to its host that you are the rightful owner" — our edge
already proves it; the mask is just the _width_ of what a proven owner
gets back.

---

### Appendix: source list

- Cap'n Proto `persistent.capnp` —
  github.com/capnproto/capnproto/blob/master/c++/src/capnp/persistent.capnp
- Kenton Varda, capnproto list, SturdyRef thread —
  groups.google.com/g/capnproto/c/d6uPbXf9e4E
- Cloudflare blog, "We've added JavaScript-native RPC to Cloudflare
  Workers" — blog.cloudflare.com/javascript-native-rpc/
- capnweb README — github.com/cloudflare/capnweb
- Sandstorm developer docs, "User authentication & permissions" —
  docs.sandstorm.io/en/latest/developing/auth/
- Miller, Yee, Shapiro, "Capability Myths Demolished" (2003) —
  srl.cs.jhu.edu/pubs/SRL2003-02.pdf
- Hardy, "The Confused Deputy (or why capabilities might have been
  invented)" (1988) — css.csail.mit.edu/6.858/2015/readings/confused-deputy.html
- Walnut, "Capability Patterns" (facets, caretakers, membranes; Redell
  1974 revocation) — wiki.erights.org/wiki/Walnut/Secure_Distributed_Computing/Capability_Patterns
  (erights.org intermittently unreachable during research)
- Birgisson et al., "Macaroons: Cookies with Contextual Caveats for
  Decentralized Authorization in the Cloud" (NDSS 2014) —
  theory.stanford.edu/~ataly/Papers/macaroons.pdf
- Biscuit tokens — biscuitsec.org
- In-repo: `apps/os/docs/itx-next.md`
  (address unification, LOCKED sections), `apps/os/src/itx/{itx,handle,access,entrypoint,fetch,refs}.ts`,
  `apps/os/src/itx/DECISIONS.md` (D7, D16–D18),
  `packages/shared/src/auth-claims.ts`,
  `docs/domain-objects-and-stream-processors.md`
