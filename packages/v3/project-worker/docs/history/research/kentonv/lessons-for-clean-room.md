# Lessons for the clean room — Kenton Varda's positions × our implementation

This file cross-references the two collectors' verbatim-quote archives (`a-*.md`, `b-*.md` in
this directory — things Kenton Varda has personally said in workerd/workers-sdk/capnweb/capnproto
threads, rpc.capnp comments, HN, and blog posts) against `packages/v3/project-worker/src/` at the
`annotations-1` state. Each lesson pins one of his positions to specific, verified lines of our
code and gives a verdict: **ALIGNED** (we already do this — the entry says exactly what matches,
so the claim is checkable), **APPLY** (a concrete change we should make), **DISCUSS** (a tradeoff
the owner must call), **N/A** (noted for the record). Lessons are ordered most important first:
gaps and open calls before confirmations. Where alignment came from the earlier Kenton-bar review
(`REVIEW-KENTON.md`, increment 30/31) rather than original design, that is said — this is a map,
not credit. Archive citations name the file, the entry heading, and the original source.

---

## 1. Block Object-inherited properties at the step walk, in both codec halves

**Kenton:** Properties inherited from `Object` are ones every object has whether it wants to or
not — RPC must never expose them, and reserved-name filtering must happen server-side, at the
dispatch point, not in the client — a-rpc-stubs-lifecycle.md, entry "Which methods are exposed
over RPC: the whole `constructor` / Object-prototype doctrine" (workerd PR #1028,
discussion*r1409945331; also "Reserved names filtered server-side, not client-side", PR #1311)
**Us:** Only the string-half parser blacklists three names (`__proto__`/`constructor`/`prototype`)
— `src/core/expression.ts:242`; the structured half (`invoke(["itx","kv",["constructor"]])`) and
the dotted door (`invokeCapability("itx.kv.toString")`, `src/stream-durable-object.ts:268-272`)
skip that check entirely, and `walkSteps` resolves steps with a bare `Reflect.get`
(`src/core/expression.ts:498`, `:502-506`), so a remainder replayed onto a plain view object
(e.g. the `roots.kv` view) will happily find and call `toString`, `hasOwnProperty`,
`__defineGetter__`, etc.
**Verdict:** APPLY
The parser check is client-side filtering in Kenton's exact sense: two of the three doors bypass
it. The fix is one guard at the shared chokepoint — in `walkSteps`, treat a step as \_missing*
(same error as an unknown method, per his "identical errors so clients can't probe" rule from the
same review) whenever the resolved property is inherited from `Object.prototype` and not
overridden. The stateful runner's private segment walk
(`src/stateful-worker-durable-object.ts:123-135`) needs the same guard for the plain objects it
walks after the first await (workerd already filters the stub hop itself). Today's practical
exposure is low (JSON args can't smuggle functions into `__defineGetter__`), but the doctrine
exists precisely so nobody has to re-derive that argument every time the views grow.

## 2. `?ctx=` on `/api` is designation without introduction — a global namespace

**Kenton:** The worst failure of CORBA-era security was "all objects existed in a global
namespace and any client could connect to any object"; the fix is that you obtain an object only
by being handed it (his `authenticate()` pattern: the only way to get a `User` is
`checkCookie()`) — b-capnproto-rpc.md, entry "Why COM/CORBA/SOAP failed and Cap'n Proto doesn't —
the five reasons" (HN 45473473, reason 5); b-ocap-philosophy.md, entry "The authenticate()
pattern: security you cannot forget to apply" (blog.cloudflare.com/javascript-native-rpc/)
**Us:** Any caller can mint a `ProjectSession` for any project by naming it in a query parameter —
`src/worker.ts:50` (`url.searchParams.get("ctx") ?? "prj_demo"`), same for `/cap` and `/state`
via `host()` at `src/worker.ts:36`; nothing consults `itx.auth.gate`
(`src/worker.ts:25-28` defines it in the solo fallback, but no code path calls it).
**Verdict:** DISCUSS
Inside the ocap frame everything downstream is right — a session is bound to one project
(`src/core/itx-surface.ts:100-108`), and the DO's table is default-deny — but the front door
grants the session by guessable name, which is the ambient-authority shape Kenton spends five
reasons attacking. This is acknowledged clean-room scaffolding (the deployed shape puts the
control plane in front), but the lesson should be recorded as a hard invariant for
productionizing: the project id must arrive as an unforgeable introduction (minted key /
control-plane-issued token), never as caller-chosen designation, and the `authenticate()` shape —
a gate call that _returns_ the session — fits our `/api` surface exactly.

## 3. A facet's persisted fold can outrun the parent's durability

**Kenton:** Output gates make it impossible to _observe_ that an actor kept running past an
unconfirmed write; anything observable — even a TCP connect — must be held until the write is
durable, and if the flush fails the world must never learn the write "happened" —
a-durable-objects.md, entries "How output gates work" and "The output gate must block _anything
observable_" (workerd PR #6533); b-durable-objects-design.md, entry "Contagious output gates"
**Us:** `append` commits to SQLite then fire-and-forgets `facet.deliver`
(`src/stream-durable-object.ts:141-153`); the facet reads the parent's log over a loopback RPC
(`src/processor-facet.ts:205-209`) and persists its cursor + fold in its _own_ facet storage
(`src/core/processor.ts:329-335`).
**Verdict:** DISCUSS
The fire-and-forget drive itself is safe by design — it is only a wake-up, and cursor-driven
delivery re-reads the log (`src/core/processor.ts:348-366`) — that half is aligned. The open
question is whether a facet counts as "the rest of the world" for the parent's output gate: if
parent→facet replies are _not_ gated (facet calls are local to the actor), the facet can fold an
event whose parent commit later fails, durably persist a cursor past it, and — because SQLite's
autoincrement counter rolls back with the failed commit — permanently skip the _different_ event
that later reuses that offset (`src/core/processor.ts:312` dedupes on `offset <=
reducedThroughOffset`). The exposure is a failed durable flush, i.e. rare, but it violates the
invariant that a cursor must only ever be _behind_ durable truth. Options for the owner: verify
empirically whether facet-bound replies wait on the parent's gate; await `ctx.storage.sync()`
before driving facets; or stamp reads with a log epoch so a facet can detect divergence.

## 4. Don't create storage for a DO that was never really used

**Kenton:** "It's supposed to be the case that if a DO does not invoke any storage APIs, then the
backing storage is never created at all… important for use cases that use DOs for coordination
only" — and implicit deletion of empty objects depends on it — a-durable-objects.md, entry "DO
lifecycle rule: if you never touch storage, storage must never exist" (workerd PR #6101)
**Us:** The `StreamDurableObject` constructor unconditionally runs `CREATE TABLE` and writes the
incarnation counter on every construction — `src/stream-durable-object.ts:82-92` — before the
name guard at `src/stream-durable-object.ts:97-100` ever runs, so any touch (a typo'd `?ctx=`, a
probe, an id-addressed mistake) mints permanent storage and forecloses implicit deletion.
**Verdict:** APPLY
The concrete change: make table creation lazy (first `append`/`read`), load-and-bump incarnation
lazily too, and run the named-id check before the first write, so a mis-addressed or merely
probed stream leaves nothing behind and stays eligible for workerd's empty-object cleanup. The
incarnation counter is deliberate observability (the hibernation tell from increment 29) and
survives this change — bumping on first _meaningful_ use per incarnation preserves the signal.
Kenton's PR-rejection reasoning is exactly our situation: metadata written on startup "breaks the
feature" of free coordination-only objects, and it is "best to do now, not later after a bunch of
these tables have already been written to disk" (a-design-philosophy.md, "Schema/table cleanup is
cheapest before anything is written to disk").

## 5. The mount table is the auditable-grants store that stub storage is promised to become

**Kenton:** Storing live stubs is "INHERENTLY INSECURE… WILL be retracted", and the endgame he
names twice is "a system that actually stores information about known 'grants' in some separate
storage, so that they can be audited and revoked" — a-rpc-stubs-lifecycle.md, entries
"Irrevocable stub storage: loud warnings, both ends must opt in" (compatibility-date.capnp flag
doc) and "Channel tokens…" (workerd@e1c36e54)
**Us:** We never persist a stub: a live capability is parked as a socket + attachment and what
gets _stored_ is a mount row — an event in the log (`capability-provided`, offset as identity)
whose target is the name `itx.clients.get(socketId)` — `src/core/itx-surface.ts:191-203` (the
park + alias desugar), `src/iterate-context-stream-processor.ts:99-106` (the fold),
`:129-137` (revoke-by-offset).
**Verdict:** ALIGNED
This is checkably the design he says the platform must eventually grow: grants live in separate,
inspectable storage (an event-sourced table with full provenance), revocation is deletion of the
grant (pop the row; the thing it named is untouched), and the _live_ connection is a separate,
naturally-expiring object (socket dies → the name dangles → callers get "offline", never stale
authority). His channel-token warning — "it would be very bad if an attacker were able to specify
such a triplet directly" — is why our stored form carries no authority at all: an expression is
re-evaluated against the resolver's scope every time, so possessing the bytes of a mount row
grants nothing.

## 6. The capnweb #36 hibernation blueprint — independent convergence, verified piece by piece

**Kenton:** His long-term plan: terminate the Cap'n Web session in a stateless worker (the DO
sees only Workers RPC); make inbound stubs recreatable after hibernation; give the DO a space for
_outbound_ stubs that survives hibernation — b-capnweb.md, entry "The long-term hibernation
design: three composable pieces, all in the Workers runtime, none in Cap'n Web" (capnweb #36,
2026-03-11)
**Us:** Piece 1 verbatim: capnweb terminates only at `/api` in the stateless worker, the DO is
reached over Workers RPC (`src/worker.ts:46-51`, hard rule stated at
`src/core/itx-surface.ts:1-3`). Piece 3 emulated in userspace: the outbound-stub space is the
Pager sockets + attachments (`src/core/hibernatable-pager.ts:1-8`,
`src/core/hibernatable-stub.ts:5-13`), with short-lived Invoker legs materialized per burst and
dropped at quiescence (`src/core/hibernatable-stub.ts:90-100`). Piece 2 we sidestep rather than
implement: no inbound RPC stub into the DO isolate ever exists — clients hold `RpcTarget`
wrappers in the relay that re-address the DO by name per call.
**Verdict:** ALIGNED
The convergence is real and precise, with two honest differences. First, our outbound space
survives _DO_ hibernation but not relay death — increment 29 measured workers.dev recycling the
`/api` isolate and taking pagers with it; the heal is reconnect-and-replace-by-`connectionKey`
(`src/stream-durable-object.ts:333-354`), which is exactly option 3 of his own reconnect taxonomy
("recreate stubs by replaying the same calls" — b-capnweb.md, entry "Reconnection: the unanswered
design question", capnweb #58). Second, his runtime version would make the space durable past
both; ours deliberately ties liveness to the socket, so a dead provider _reads_ as dead. His "a
DO stub held elsewhere doesn't prevent hibernation, only active calls do" (same file, "What
blocks a DO from hibernating") is the exact license our relay relies on by holding `#host`
persistently.

## 7. Ship the whole call path in one message; apply the ops at the destination

**Kenton:** The point of the RPC protocol is "as soon as you finish that previous call, do this
with the result" — pipelining is what lets you keep fine-grained object interfaces without paying
a round trip per step — b-capnproto-rpc.md, entries "The thesis: a surprisingly complicated
protocol implementing a conceptually-simple object abstraction" (rpc.capnp:27-40) and "Time
Travel: the canonical promise-pipelining pitch" (doc/rpc.md)
**Us:** A dispatch is one message carrying the entire expression — the dotted door joins the path
client-side and the resolver walks it co-located with the table
(`src/stream-durable-object.ts:268-272`); the stateful runner receives a dotted `method` and
walks segments locally next to the facet (`src/stateful-worker-durable-object.ts:123-135`);
`stubInvoke` carries the full segment list to the parent in one hop
(`src/roots-builder.ts:145`); and remainder-replay onto an evaluated target
(`src/core/expression.ts:550`) is literally "do this with the result."
**Verdict:** ALIGNED
The moral structure of pipelining — the path travels as data, the ops execute where the object
lives — is our dispatch shape, not an optimization we lack. The known refinement is honest and
already written down in-code: `walkSteps` awaits every step (`src/core/expression.ts:495`), so
when a remainder walk crosses a live Workers-RPC stub mid-walk we pay a round trip per step where
native thenable pipelining would pay one; `src/core/agent-runtime.ts:6-7` records "promise
pipelining of chained calls is a later refinement." (Awaiting unconditionally rather than
inspecting for async-ness is itself his doctrine — a-rpc-stubs-lifecycle.md, "Don't detect async
by declaration — call the function and check for a Promise".)

## 8. Never rely on two sequential calls hitting the same live instance

**Kenton:** "There's no guarantee that the DO doesn't hibernate in between… The _safe_ thing to
do is to have the first call return an RpcTarget, and the second call is pipelined on that" —
a-durable-objects.md, entry "Don't rely on call ordering for initialization — hibernation can
strike between any two calls" (workerd PR #6562)
**Us:** Nothing in the system depends on in-memory state surviving between calls: facet identity
is stashed durably at first contact and rehydrated by every incarnation
(`src/processor-facet.ts:128-130`, `:197-208`); the back-channel is re-resolved _by name_ per
call, never a retained stub (`src/processor-facet.ts:205`, `src/roots-builder.ts:141-151`);
delivery is cursor-driven from the durable log so a drive lost to a restart is harmless
(`src/core/processor.ts:348-366`); and the session flow follows his prescribed shape —
`ProjectSession.get()` returns an `RpcTarget` synchronously so subsequent calls pipeline onto it
(`src/core/itx-surface.ts:111-113`).
**Verdict:** ALIGNED
The alignment is checkable as an absence: grep the codebase for any state that must survive from
one RPC to the next in memory — there is none; `configure`-then-`deliver` tolerates an eviction
between them because `#boot` reads identity back from the facet's own kv. Where apps/os
historically leaned on wake protocols and keepalives, the clean room's answer to "which instance
am I talking to?" is always "whichever one the durable name resolves to, rebuilt from durable
state."

## 9. Expressions are names, never authority — the Restore post-mortem, answered

**Kenton:** Overloading `Restore` with well-known string names was a security trap he retracted:
a supervisor forwarding restore requests "has to be very careful not to allow through" requests
naming the privileged default capability, which cannot itself be given an unguessable name —
b-capnproto-rpc.md, entry "The `Restore` post-mortem: why 'well-known capabilities by string
name' is a security trap" (rpc.capnp:323-386)
**Us:** A stored expression confers nothing: every evaluation re-derives authority from the scope
it is handed (`src/core/expression.ts:10-12`), and the privileged root is not _policed_ but
_absent_ — `roots` is in scope only while resolving a config-provenance row
(`src/iterate-context-stream-processor.ts:162-164`), `provide()` rejects `roots`-targets outright
(`src/iterate-context-stream-processor.ts:117-118`), and the `Roots` object is pre-scoped so a
cross-project reference is unspellable (`src/core/roots.ts:3-8`).
**Verdict:** ALIGNED
Our answer to his confused-deputy scenario is structural: the "supervisor" (the resolver) never
needs to inspect names for privilege because event-provenance rows literally cannot spell the
physical layer — the vocabulary does not exist in their scope. His SturdyRef lifecycle advice
lands too: "design systems such that SturdyRefs never represent 'owned' pointers" — revoking a
mount pops the grant and leaves the named thing untouched, exactly his image-in-a-gallery
example. The default route (`itx ⇒ itx.os` forwarding whole missed calls) is the one place his
supervisor scenario could re-emerge if the forward target ever had privileged reach; today it
forwards into `FALLBACK`, which sees only the public capability fallthrough.

## 10. Keep the op-set frozen; design narrow ops as if scripts were the eventual goal

**Kenton:** "Probably not a good idea: the ability to specify an arbitrary script to run on the
result… Although this is not a good idea (over-engineered), any narrower additions to `Op` should
be designed as if this were the eventual goal" — b-capnproto-rpc.md, entry "PromisedAnswer.Op:
the famous 'probably not a good idea' pre-rejection" (rpc.capnp:1120-1141)
**Us:** The header contract: "The op-set is get + call + hole, and NEVER grows (Cap'n Proto kept
pipelining to one op for 13 years; anything smarter belongs in the project's config worker as
real code, mounted plainly)" — `src/core/expression.ts:8-9`, and the codebase holds to it: match,
substitute, and evaluation all close over exactly those three ops.
**Verdict:** ALIGNED
This is a deliberate citation of his doctrine, and the escape hatch has the right shape: when a
mount needs logic beyond hole-plumbing, the answer is real code in a confined worker reached
through an ordinary mount (`src/roots-builder.ts:64-115`), not a richer op. Cap'n Web's own
`.map()` proves the pattern's ceiling — his record-replay DSL "is just the RPC protocol itself"
(b-capnweb.md, "The record-replay .map()"), and our substitution grammar has the same property:
the mount-target language _is_ the call language, no second interpreter.

## 11. Attenuation is per-context, not per-client — bindings, not yet full ocap

**Kenton:** Scoring his own bindings honestly: "bindings are not a complete capability system. In
particular, there is currently no particular mechanism for a Worker to pass a binding to another
Worker" — and the compensation he sketches is the pseudo-ACL: audit and revocation layered on
observed capability movement — b-ocap-philosophy.md, entries "'Is this capability-based
security?' — his own honest scoring of bindings" and "The Google Docs sharing example"
(HN 10686990)
**Us:** Every holder of a project session sees the project's whole table — `Itx.invokeCapability`
is unattenuated (`src/core/itx-surface.ts:150-152`); narrowing happens at context granularity
(each `{projectId, path}` stream has its own table and seeds), not per client of one context.
**Verdict:** DISCUSS
We sit exactly where bindings sit on Kenton's own honesty scale, plus the pseudo-ACL he wished
for (the mount log is an audit trail with revocation). The open call: is "give a subordinate its
own context with its own mounts" sufficient attenuation, or do we need per-session narrowing on
a single context (his `checkCookie() → User` move: hand back an object that _is_ the attenuated
view)? Contexts are cheap here, which argues the first answer is fine; but the moment two
differently-trusted clients share one context path, we have no way to show them different tables.
Decide before that moment arrives, not after.

## 12. Facets instead of dynamic DO namespaces

**Kenton:** "Dynamically loading workers makes sense, but dynamically creating DO namespaces
seems wrong… With facets, there's only one namespace needed — the one for the root facet.
Deleting the root facet deletes all the children" — a-facets.md, entry "Why facets instead of
groups of Durable Objects" (workerd PR #4123 comment)
**Us:** Userspace processor classes load through the Worker Loader and run as facets _of the
stream DO_ (`src/stream-durable-object.ts:182-214`), named `proc:${slug}` under the parent; the
one dynamic-worker DO we do keep (`StatefulWorkerDurableObject`) is a _static_ namespace whose
instances host user classes as single facets (`src/stateful-worker-durable-object.ts:80-103`) —
no namespace is ever minted at runtime.
**Verdict:** ALIGNED
This is the intended use of his feature, down to the motivating sentence — dynamically-loaded DO
classes with nowhere sane to live are exactly our userspace processors. We also inherit the
lifecycle he designed: aborting on source change keeps storage
(`src/stream-durable-object.ts:205-210`), transitive delete rides the parent, and the facet's
"own execution context, no shared globals" rule (a-facets.md, workerd #6702) is why the clients
view is thin RPC wrappers over the parent's stub facade rather than shared objects
(`src/processor-facet.ts:18-22`).

## 13. Per-context cache keys multiply ~5MB isolates

**Kenton:** "The actual number is more like 5MB" per isolate, and unpacking built-ins is the main
cost of starting one — a-runtime-isolates.md, entry "The real cost of an isolate, and why
continuation-serialization is the wrong fix" (workerd #6595)
**Us:** Every loader cacheKey embeds the owning context (`code:${v}:${contextName}:${hash}` —
`src/roots-builder.ts:73`, `:89`; `stateful:${v}:${ctx.id.name}:${hash}` —
`src/stateful-worker-durable-object.ts:91`; `procfacet:${v}:${doName}:${slug}:${hash}` —
`src/stream-durable-object.ts:196`), so N contexts running the same source hold N isolates.
**Verdict:** DISCUSS
The per-context key is not an accident — it is forced by the confinement contract, because
`env.ITX` and `globalOutbound` bake the owning host into the isolate
(`src/core/agent-runtime.ts:64-65`). Kenton's own platform faced the same tension and solved it
with parameterized entrypoints: ctx.props + channel tokens let _one_ isolate serve many
principals, with the authority in the per-call props instead of the env (a-rpc-stubs-lifecycle.md,
"ctx.props: bindings as capabilities"; b-hn-commentary.md, "Workers Cache redesign"). If contexts
× sources grows, that is the shape to steal: content-hash-only cacheKey, host handed per-request.
Until then, 5MB × (contexts × sources × deploys-in-flight) is the budget line to watch — the
worker-loader OOM class is real in local dev already.

## 14. Dynamic-entrypoint stubs can never transfer — our two loud learnings are the userspace mirror

**Kenton:** "It's important that any bindings passed to it can be loaded from scratch locally…
we can't possibly support this for dynamically-loaded workers because we don't know how to reload
them without the app's help. So, let's enforce that entrypoint stubs to dynamically-loaded
workers cannot be transferred" — a-rpc-stubs-lifecycle.md, entry "Bindings passed across machines
must be reloadable from scratch — so dynamic-worker stubs can't transfer" (workerd@15630426)
**Us:** Both LOUD comments are consequences of exactly this enforcement: invoke facet methods
with `Reflect.apply` so the stub is never serialized as a value
(`src/stateful-worker-durable-object.ts:110-122`), and fold the deploy id into the loader
cacheKey so a durable DO never calls into a prior deployment's isolate
(`src/stateful-worker-durable-object.ts:82-91`, echoed at `src/stream-durable-object.ts:192-199`).
**Verdict:** ALIGNED
The archive turns our hard-won `DataCloneError` investigation from folklore into doctrine: the
`requireAllowsTransfer()` throw we hit is his deliberate enforcement of "reloadable from scratch,"
not an entitlement bug. The design consequence we drew is the right one — a dynamic facet's stub
lives and dies inside its owning DO; only plain data and by-name addresses cross boundaries —
which is also why the runner resolves _source expressions_ through the host rather than shipping
module maps around (`src/stateful-worker-durable-object.ts:61-63`).

## 15. dup() before retaining; dispose at quiescence; the callee owns cleanup on throw

**Kenton:** "Stubs received in the parameters of an RPC call are automatically disposed when the
call returns. If you want to keep the stub around beyond that, you need to `.dup()` it and store
the duplicate" — and ownership on failure "should always be the callee's responsibility" —
b-capnweb.md, entries "Stub lifetimes through stateless hops: the dup() contract…" (capnweb #110)
and "Misc engineering judgments" (PR #241); a-rpc-stubs-lifecycle.md, entry "params stubs are
dup()ed, not ownership-transferred" (`rpcParamsDupStubs` flag doc)
**Us:** `startRelay` dups the incoming provider before retaining it and disposes on close/dispose
(`src/core/itx-surface.ts:70`, `:80-92`); the DO dups the Invoker leg it stores past the
`activateStub` return (`src/core/hibernatable-stub.ts:109`) and disposes the previous one on
replace (`:111`); `invoke` disposes the leg in a `finally` at quiescence, throw or not
(`src/core/hibernatable-stub.ts:95-99`); `#forget` disposes and rejects pending borrowers
(`:172-184`); disposal itself has ONE spelling (`disposeStub`, `:41-44`).
**Verdict:** ALIGNED
Every retention site in the transport follows the dup contract, including the subtle one — the
leg received _in the params_ of `activateStub` and stored beyond the call — and we avoid the
`new RpcStub(alreadyAStub)` wrapper mistake from his #110 walkthrough entirely. His "not
thrilled" double-ownership rules are exactly why the registry treats legs as owned-by-the-map
with one dispose path; the `dup?.() ?? input.invoker` fallback keeps tests honest without
weakening the production path.

## 16. Depth budgets: mount recursion is capped, the JSON walks are not

**Kenton:** Receiver-side limits must not reset ("I actually don't think call arguments should
reset the limit. Otherwise that still allows a stack overflow with extremely nested calls") and
cycles/backreferences are a DoS surface the receiver must be able to bound — b-capnweb.md, entry
"Receiver-side resource limits: depth budgets must not reset…" (capnweb PR #185);
b-hn-commentary.md, entry "Cycles and backreferences in serialization = DoS surface" (HN 11030323)
**Us:** Mount resolution carries a non-resetting depth budget of 32 through re-entry
(`src/iterate-context-stream-processor.ts:152-153`, threaded via `#itxAtDepth`), which handles
the alias-cycle case; but the plain-JSON recursions — `substituteValue`
(`src/core/expression.ts:444-477`), the hole scan (`:421-434`), `jsonEqual`
(`src/core/events.ts:64-85`), and the parser's `#value` (`src/core/expression.ts:129-154`) — have
no depth cap.
**Verdict:** DISCUSS
Cycles cannot occur (everything is parsed JSON, and we have no custom serializers — itself
aligned with his "enormous security footgun" ruling in b-capnweb.md, PR #155), so the only
exposure is stack exhaustion from deeply-nested-but-acyclic input supplied by an authenticated
project client through `provide`/`append`. `JSON.parse` fails loudly on absurd depth and workerd
RPC imposes its own limits upstream, so this may already be bounded in practice — the call is
whether a small shared depth counter in the walks is worth it as defense-in-depth versus trusting
the transport's limits. If added, follow his rule: one budget, never reset at argument
boundaries.

## 17. Durable first-contact identity, because facet start callbacks don't re-run

**Kenton:** He changed `facets.get()` to take a callback that "is not called if the facet is
already running" — matching worker-loader — precisely because comparing per-start parameters for
equality is intractable — a-facets.md, entry "Why `facets.get()` takes a callback for start info
(matching worker-loader)" (workerd@026eede2)
**Us:** Our `facets.get` callbacks return only `{ class }`; everything instance-specific arrives
once via `configure(identity)` and is stashed in the facet's own kv
(`src/processor-facet.ts:128-130`), rehydrated by `#boot` on every incarnation (`:197-208`); the
parent re-configures idempotently in `enableProcessor` (`src/stream-durable-object.ts:219-230`).
**Verdict:** ALIGNED
This is the correct adaptation to his API semantics: since the start callback cannot be relied on
to deliver fresh parameters (it may simply not run), identity must not ride in it — and ours
never does. The version-marker abort pattern (`src/stream-durable-object.ts:205-210`) is likewise
the sanctioned way to force a class change under his "if you want to change the class, abort()
the existing facet first" rule, while keeping storage.

## 18. Parent owns alarms; when they arrive, schedule "no later than," never late

**Kenton:** The alarm invariant is asymmetric — "it's always OK if the alarm time accidentally
gets left being too early — you'll just reschedule it when it fires prematurely"; he renamed the
field `alarmScheduledNoLaterThan` to encode it — a-durable-objects.md, entry "Alarm scheduling
invariant…" (workerd PR #2648); and facet alarms are broken today (a-facets.md, "Known facet
gaps", workerd #6810)
**Us:** Facets deliberately have no alarms; the stance "the parent proxies when a processor needs
one; none does yet" is written where facets are hosted — `src/processor-facet.ts:18-19` — and no
`setAlarm` call exists anywhere in `src/`.
**Verdict:** ALIGNED
The stance is right twice over: #6810 shows a facet `setAlarm` silently poisons the actor's
commit path in dev, and the parent-owns-alarms shape means alarm state lives beside the log it
will drive. Forward guidance for the day a processor needs one: adopt the asymmetric invariant
verbatim (persist "no later than", update optimistically only when moving later, and implement
his premature-fire recovery — on early fire with no matching obligation, re-schedule to the
stored time and do nothing).

## 19. Streams ride the fetch lane, never per-chunk RPC

**Kenton:** Converting `read()`/`write()` into per-call RPCs "would only be able to achieve
40kps" on a 100ms link — streams need real flow control, which the transport must provide —
b-capnweb.md, entry "Streams over RPC need real flow control — naive read()/write() RPCs cap you
at 40kB/s" (capnweb PR #94)
**Us:** Anything stream-shaped travels as a native `fetch` end to end: the `x-itx-cap` door
forwards the live Request into the capability-host facet's own `fetch` so a 101/stream tunnels
untouched (`src/stream-durable-object.ts:294-296`, `src/processor-facet.ts:167-171`), the
stateful runner does the same DO→DO→facet (`src/stateful-worker-durable-object.ts:139-148`), and
the resolver treats a Request as a runtime argument that never enters the JSON walk
(`src/iterate-context-stream-processor.ts:173-184`).
**Verdict:** ALIGNED
The fetch lane is the architectural answer to his objection: bulk and streaming payloads stay on
transports that already have flow control (HTTP bodies, WebSocket frames), while the expression
lane carries only calls and JSON. The discipline to keep: never add a "read a chunk" capability
to the RPC lane — if something wants to stream, it earns a `fetch` terminal.

## 20. Every fire-and-forget attaches `.catch`

**Kenton:** "If you ignore errors, then there are all sorts of ways your callback _might not run
at all_ without you realizing it… you REALLY need to attach a `.catch()`" — b-capnweb.md, entry
"Unawaited call promises are pipelining references — dispose them, and ALWAYS attach .catch()"
(capnweb PR #154)
**Us:** All three fire-and-forget sites are handled: the facet drive logs failures
(`src/stream-durable-object.ts:150-152`), `runInBackground` wraps every task
(`src/core/processor.ts:298-301`), and the pager wake-answer swallows _deliberately_, with the
reason written at the call site — a stale wake is a documented non-event
(`src/core/itx-surface.ts:75-78`).
**Verdict:** ALIGNED
Checkable by grep: every `void`-ed or un-awaited promise in `src/` has a `.catch`. The deeper
alignment is that fire-and-forget is only ever used where the system is _designed_ to not need
the result — drives are wake-ups over a cursor, background work is a droppable attempt whose
outcome must be state-recoverable (`src/core/processor.ts:13-16`) — so a swallowed error can
delay progress but never lose it.

## 21. A fresh cancellation promise per wait — the Promise.race lesson

**Kenton:** Racing each read against one session-long abort promise leaked "not just promise
nodes but the entire received messages. OMG" — b-capnweb.md, entry "The Promise.race() leak that
ate whole messages" (capnweb #158 / PR #154)
**Us:** The only wait-with-timeout in the transport allocates a fresh promise and timer per
pending wake, shared by concurrent borrowers of the _same_ wake, and both arms clean up: the
timer is cleared on activation (`src/core/hibernatable-stub.ts:112-113`) and the pending entry
deleted on timeout or disconnect (`:156-159`, `:177-181`); `waitUntilProcessed` likewise clears
its timer on resolve (`src/core/processor.ts:422-443`).
**Verdict:** ALIGNED
No `Promise.race` against a long-lived promise exists in the package. The shape that made his
leak possible — one immortal promise accumulating a listener per operation — is structurally
absent: every pending wait is keyed, single-purpose, and removed from the map on all three exits
(resolve, timeout, forget).

## 22. One detector, one schema, one proxy — duplicated parsing diverges

**Kenton:** "Currently you've implemented entirely new, separate parsing code, duplicating the
code that already exists — let's not do that", and delegating to the existing path is how new
properties don't get forgotten — a-design-philosophy.md, entries "Error classification…"
(workerd PR #6443) and "Delegate to the existing path so new properties can't be forgotten"
(PR #6730)
**Us:** After the Kenton-bar review there is exactly one hole detector (`holeKind`,
`src/core/expression.ts:56-65`, consumed by match/substitute/must-use —
`src/iterate-context-stream-processor.ts:253-263`), one wire schema (`ExpressionSchema`,
`src/core/expression.ts:47-49`), one dotted proxy (`pathProxy`, `:595-607`), one deep-equal
(`jsonEqual`, `src/core/events.ts:63-64`), one loader wiring (`confinedWorker`,
`src/core/agent-runtime.ts:53-67`), one disposer (`disposeStub`).
**Verdict:** ALIGNED
This alignment was _earned by a bug_, which is what makes it checkable: `walkHoles` briefly had
its own hole detector, disagreed with `substitute` about `$`-escapes, and produced wrong must-use
verdicts (REVIEW-KENTON.md, FIX-NOW #4) — a live demonstration of the failure mode his review
comments predict. The regression test pins it. The maintenance rule going forward is his,
verbatim: extend the shared function; never write a second walker.

## 23. A hostile event must not wedge the fold — validate where you consume

**Kenton:** "Validation has to happen at the point of consumption. You should not try to validate
your data early in the pipeline because your validation rules will likely become out-of-sync with
what the consumer actually wants" — b-hn-commentary.md, entry "The `required` lesson: validation
must happen at the point of consumption" (HN 32818948)
**Us:** The log accepts a validated envelope but each processor decides for itself what an event
means: `reduce` failures are caught per-event, logged, and skipped so the fold never wedges
(`src/core/processor.ts:279-284`); contract-version bumps refold from offset 0 through `reduce`
only (`:224-240`), so a consumer's changed rules re-judge history without re-running effects.
**Verdict:** ALIGNED
The event log is deliberately the permissive middle of the pipeline (capture verbatim, envelope
only — `src/core/events.ts:9-33`), and interpretation lives with each consumer, which is exactly
his conclusion from the `required` fiasco. One nuance worth keeping in mind rather than changing:
a skipped event is invisible except in logs; if a fold ever guards money-shaped state, the skip
should also leave a mark in state (his lesson is that the _consumer_ decides — deciding loudly is
still deciding).

## 24. Choose defaults so mistakes fail loudly, not leakily

**Kenton:** `releaseParamCaps` defaults true "because if level 0 implementations forget to set it
they'll never notice (just silently leak caps), but if level >=1 implementations forget… they'll
quickly get errors" — design every default for failure-mode asymmetry — b-capnproto-rpc.md, entry
"Default-true release flags: design so that level-0 implementations fail loudly, not leakily"
(rpc.capnp:513-521)
**Us:** The same asymmetry governs our edges: an explicit `{"seeds": []}` means deny-all, never
"give me the defaults" (`src/core/config.ts:43-53`); an idempotency-key collision with a
different body is a loud conflict, never a silent dedupe
(`src/stream-durable-object.ts:117-130`, `src/core/events.ts:46-48`); an undeclared emit throws
(`src/core/processor.ts:256-259`); no table match is default-deny with a self-diagnosing message
(`src/iterate-context-stream-processor.ts:156-159`); a hole-free target receiving bound args is a
must-use error at registration (`:241-251`).
**Verdict:** ALIGNED
In every case the dangerous misreading (silent grant, silent drop, silent shadowing of caller
input) is the one that throws, and the safe reading is the default. The config rule is the
sharpest instance: absence of config is the only spelling of "defaults", so a present-but-empty
config can never accidentally widen.

## 25. Name-addressed only — refusing raw ids sidesteps the ctx.id.name trap

**Kenton:** `ctx.id.name` is unimplementable-in-general because ids round-trip through strings
and lose the name, and storing the name as metadata collides with empty-object deletion —
a-durable-objects.md, entry "Why `ctx.id.name` is hard: IDs round-trip through strings and lose
the name" (workerd #2240)
**Us:** Both durable classes refuse to exist without a name and derive their whole identity from
it: `src/stream-durable-object.ts:97-100` (throws for id-addressed instances; identity parsed
from the codec name via `src/core/names.ts`), `src/stateful-worker-durable-object.ts:69-75` (the
runner reconstructs its owning context from its own name and throws otherwise).
**Verdict:** ALIGNED
Every subtlety in his #2240 thread — lost names after `idFromString`, where alarms would store
the name, giant names — is moot for a system that makes the name the _only_ address and fails
early on anything else (the fail-early throw came from the Kenton-bar review, FIX-NOW #12). The
codec (`{projectId}.iterate{path}`) additionally makes the name carry the isolation boundary, so
"which project does this DO belong to" is answerable from the address alone, with no metadata
write — precisely the write he refused to accept in PR #6101 (see lesson 4).

## 26. Synchronous storage in the commit path

**Kenton:** "You might as well consider the local disk as just another layer in the memory cache
hierarchy… with a synchronous API, none of that can happen. Your code always executes in the
order you wrote it, uninterrupted" — b-durable-objects-design.md, entry "Synchronous SQLite:
'disk is L5 cache', and why sync APIs kill a class of bugs"; a-durable-objects.md, entry "The
synchronous KV API: why `storage.kv`" (workerd@123c205a)
**Us:** The commit path is await-free where it matters: the event insert and offset read are
synchronous `sql.exec` (`src/stream-durable-object.ts:133-138`), the registry's one-per-batch
progress persist is a synchronous `kv.put` (`src/core/processor.ts:334`, backed by
`ctx.storage.kv` at `src/processor-facet.ts:211-214`), and facet identity uses `storage.kv`
(`src/processor-facet.ts:129`).
**Verdict:** ALIGNED
Using the sync APIs means the interleaving bugs his post describes — state changing across an
awaited storage call — cannot occur in append or in the batch-commit step, and the no-await
coalescing rule makes each of those blocks atomic. The one deliberate exception proves the model:
the incarnation bump uses async storage inside `blockConcurrencyWhile`
(`src/stream-durable-object.ts:89-92`), which is the sanctioned fence for constructor-time reads
(and is itself an argument for lesson 4's lazy-init).

## 27. Error classification by message regex vs tunneled error types

**Kenton:** RPC should "depend on the same exception tunneling logic as everyone else" — one
mechanism, no special cases — and an error's _type_ should describe how the client ought to
respond — a-rpc-stubs-lifecycle.md, entry "Exceptions over RPC: don't special-case, rely on one
tunneling mechanism for everything" (workerd PR #1028); b-capnproto-rpc.md, entry "Exception
philosophy…" (rpc.capnp:1174-1246)
**Us:** Errors cross our hops as ordinary tunneled Errors (aligned), but classification is by
message text: the fetch lane maps `/no capability matches/` to 404
(`src/processor-facet.ts:185`), and idempotency conflicts keep "message text greppable across RPC
hops" as an explicit doctrine (`src/core/events.ts:44-48`).
**Verdict:** DISCUSS
Matching on message strings is the "entirely new, separate parsing code" smell in miniature — but
the alternative is genuinely constrained here: capnweb 0.8.0 drops `error.name` in transit, so
typed errors would not survive the client hop anyway, and greppable messages are a deliberate
house choice. The call for the owner: either bless message-prefix-as-contract (name the stable
prefixes in one module so the fetch lane and future callers share them), or introduce a tiny
error-code convention _inside_ the message (his own `disconnected`-type taxonomy is about
response semantics: retry, re-resolve, give up). What should not persist is today's middle state,
where the 404 mapping silently depends on a sentence someone may innocently reword.

## 28. Know which timeout you measured — and what facets may cost while idle

**Kenton:** "Hibernation occurs after 10 seconds of _internal_ inactivity… Eviction occurs after
60 seconds (or is it 70…) of not having any clients" — two distinct timers with distinct meanings
— a-durable-objects.md, entry "The two DO timeouts: 10s hibernation (internal inactivity) vs
60/70s eviction (no clients)" (workerd PR #1138); plus the open facet gap: SQLite-backed facets
can hold the parent "idle, non-hibernatable" until forced eviction, billing duration (a-facets.md,
"Known facet gaps", workerd #6800)
**Us:** Our hibernation evidence is the `incarnation` counter, bumped on every construction
(`src/stream-durable-object.ts:78`, `:89-92`) — it detects _reconstruction_ (hibernation or
eviction indistinguishably), and increment 29's e2e observed growth only at ~300s-plus holds
(BUILD-LOG.md, increment 29), which is eviction-scale, not 10s-hibernation-scale.
**Verdict:** DISCUSS
The proofs establish the property that matters most (nothing pins the DO; parked stubs survive
reconstruction), and the controls showed facets did not _prevent_ eviction. What they do not
establish is whether the parent reaches the cheap 10s-hibernation state while facets sit idle —
#6800 says SQLite facets can forbid exactly that, converting idle sockets into billed duration
until the evictor arrives. Two cheap follow-ups: expose a probe that distinguishes the states
(his definition gives one: hibernation implies the isolate was torn down while clients stayed
connected), and watch duration billing on a context with enabled facets and zero traffic. Kenton's
"measure the thing the user could actually see" instinct applies: the bill is the observable.

---

_Cross-referenced 2026-08-18 against `src/` at `annotations-1` (post-increment-31). Line numbers
were verified against the working tree at write time; if the files move, the anchors to re-grep
are quoted in each entry._
