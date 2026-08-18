# Facets: output-gate coverage of parent↔facet RPC, and the SQLite-facet idle-billing pin (workerd #6800)

Source studied: `~/src/github.com/cloudflare/workerd`, main @ `479771c30d10a04f468c68f80714cbf4c34b9d85`
(merged 2026-08-17). All `file:line` cites are against that commit. GitHub facts fetched 2026-08-18
via `gh`. Context: our Stream DO (parent) commits events to its SQLite log, then fire-and-forgets
`facet.deliver(...)`; the facet reads the parent's log over loopback RPC (env binding
`getByName(parentId)`) and durably persists cursor+fold in the facet's own storage.

---

## QUESTION A — does the output gate cover parent↔facet RPC replies?

### VERDICT A: the hazard is IMPOSSIBLE — conditional on two things we control

A facet **cannot observe events from a parent SQLite commit whose flush later fails**, because
_every_ channel by which the parent's state can leave the parent — including RPC replies to calls
made into the parent by a facet, and RPC calls made by the parent to a facet — is held by the
parent's output gate until the flush is confirmed, and a failed flush _breaks_ the gate so those
messages are replaced by an exception and never delivered. The cursor-skip hazard therefore cannot
occur, **provided**:

1. the parent's event-log writes are _confirmed_ writes (we never pass `allowUnconfirmed: true`
   to `storage.put` — raw `sql.exec` has no unconfirmed option at all, so plain SQL is always
   safe), and
2. the facet learns parent state only through RPC/fetch (it does — there is no other channel
   between two actors; facets are separate `Worker::Actor`s with separate isolate contexts and
   storage, reachable only via channels).

The transitive abort of facets on parent failure is real but is only a _backstop_; the gating of
the reply itself is what makes the ordering airtight (see "why the abort alone would not be
enough" below).

### A.1 What the output gate is, and what locks it

- Definition: an actor's OutputGate "blocks all outgoing messages from an actor that would allow
  the rest of the world to observe the actor's state. Held while writes that have been confirmed
  to the application are still being flushed to disk. If the flush fails, these messages will
  never be sent" — `src/workerd/io/io-gate.h:18-21`; class doc `io-gate.h:248-250`;
  `wait()` = "wait until all _preceding_ locks are released; not affected by future lockWhile()"
  `io-gate.h:289-291`; a failed or cancelled `lockWhile()` breaks the gate permanently
  (`setBroken`, `io-gate.h:330-353`).
- Every actor — root or facet — owns its **own** InputGate and OutputGate:
  `Worker::Actor::Impl` members `src/workerd/io/worker.c++:3748` (inputGate) and `:3751`
  (outputGate). Facets get their own `Worker::Actor` via `actorClass->newActor(...)` in
  `ActorContainer::start` — `src/workerd/server/server.c++:1364-1367`.
- SQLite writes lock the gate at write time: `ActorSqlite::onWrite`
  `src/workerd/io/actor-sqlite.c++:391-421` — the first must-confirm write in an implicit txn does
  `commitTasks.add(outputGate.lockWhile(lastCommit.addBranch(), ...))` (`:404-407`). Explicit
  (`transactionSync`) txns lock the gate when the outermost commit is issued
  (`actor-sqlite.c++:259-262`). The gate is released only when `commitCallback` — the hook the
  embedder uses to confirm durability/replication — resolves (`actor-sqlite.h:50-55`,
  `actor-sqlite.c++:586-605`).
- `allowUnconfirmed` is the only bypass: it is a per-put option (`api/actor-state.c++:482,546`;
  plumbing `util/sqlite.h:104,509,713`). It is **not** exposed on `sql.exec` (no occurrence in
  `api/sql.c++`), so ordinary SQL writes always gate.

### A.2 Which observable channels wait on the gate

All of them. Call sites of `waitForOutputLocks*` (`IoContext::waitForOutputLocksIfNecessary`
returns the actor's `outputGate.wait()`, `io-context.c++:396-399`; `hasOutputGate()` is simply
`actor != kj::none`, `io-context.c++:392-394` — every actor, facet or root, no exceptions):

| Channel                                                                            | Site                                                                                                                                                                            |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Outgoing JS-RPC calls** (incl. parent→facet `facet.deliver(...)`)                | caller-side in `callImpl`: the client capability itself is replaced by a promise-client that waits for the caller's gate before the call is sent — `api/worker-rpc.c++:368-372` |
| **JS-RPC replies** (incl. parent's replies to a facet's loopback `getEvents(...)`) | callee-side in `JsRpcTargetBase::call` result path: `if (ctx.hasOutputGate()) return result.then([&ctx]{ return ctx.waitForOutputLocks(); })` — `api/worker-rpc.c++:1245-1253`  |
| HTTP responses from an actor, and even _exceptions_ escaping the handler           | `io/worker-entrypoint.c++:493-497` and `:698-703`                                                                                                                               |
| Outgoing `fetch()` subrequests                                                     | `api/http.c++:1710`, `:2021`                                                                                                                                                    |
| Outgoing WebSocket messages (GatedMessage queue)                                   | `api/web-socket.c++:933`, `:1383`; ws connect `:539`                                                                                                                            |
| Queue sends, KV, Cache, R2, Sockets, Analytics Engine                              | `api/queue.c++:300,443`, `api/kv.c++`, `api/cache.c++`, `api/r2-rpc.c++`, `api/sockets.c++:458`                                                                                 |
| Streaming body writes (each write gated individually)                              | `api/streams/internal.c++:1091,1166,1224,1413`                                                                                                                                  |
| Alarm (re)scheduling                                                               | wrapped in `outputGate.lockWhile` — `io/actor-sqlite.c++:903`                                                                                                                   |

### A.3 Facet↔parent traffic is EXTERNAL (gated), not internal

There is no ungated fast path. `ctx.facets.get()` returns a plain `Fetcher`
(`api/actor-state.c++:1027-1101`, note the comment at `:1098-1100`), whose RPC methods go through
the same `callImpl` as any service binding (Fetcher extends `JsRpcClientProvider`,
`api/http.h:188,396`). The channel is an ordinary `ActorChannelImpl`
(`FacetManager::getFacet`, `server/server.c++:739-743`) and requests enter the facet through
`ActorContainer::startRequest` → `actorClass->startRequest` (`server.c++:617-663`) — the same
WorkerEntrypoint/JsRpcTarget edge as external traffic, so both the caller-side gate (A.2 row 1)
and callee-side gate (row 2) apply in **both** directions. The facet's loopback into the parent via
a normal DO namespace binding is likewise just an actor channel into the parent's entrypoint;
the parent's reply is gated at `worker-rpc.c++:1245-1253` regardless of who the caller is —
there is no special-casing of facet callers anywhere in the RPC layer.

### A.4 What happens when the parent's flush fails

The chain, each link in source:

1. Commit failure breaks the gate: the commit promise is wrapped in `lockWhile`
   (`actor-sqlite.c++:253-262` — "Unconditionally break the output gate if commit threw");
   `ActorSqlite::onCriticalError` also force-breaks it and marks the storage broken with
   `broken.outputGateBroken` (`actor-sqlite.c++:298-311`); invariant assert at `:645-652`.
2. Broken gate aborts the actor's IoContext: the actor IoContext registers
   `abortWhen(a.getOutputGate().onBroken())` at construction — `io/io-context.c++:212-217`
   (comment: "we need to retroactively pretend that previous execution didn't happen").
3. `Worker::Actor::onBroken()` is literally the IoContext's `onAbort()` —
   `io/worker.c++:4074-4088`.
4. The container reacts: `ActorContainer::monitorOnBroken` (`server/server.c++:994-1032`)
   records the reason, **aborts every facet with that same reason and clears the facet map**
   (`:1004-1007`), hollows out the actor, and erases the container from its parent's map /
   the namespace map (`:1023-1028`) — so the next request rebuilds a fresh actor from durable
   state only. Facet abort recurses to descendants (`ActorContainer::abort`,
   `server.c++:684-686`) and hard-cancels everything using the facet actor
   (`Worker::Actor::abort`, `worker.c++:4039-4068`). This is the "transitive abort" facets
   design goal, implemented.

### A.5 Why the hazard is impossible (and why the abort alone would NOT be enough)

Timeline of the feared scenario: parent commits events E@offsets N..M (gate locks at write time,
A.1) → facet asks the parent for events (or parent pushes them). Whichever direction:

- facet→parent read: the parent's reply carrying rows N..M is parked on
  `waitForOutputLocks()` (`worker-rpc.c++:1251`), which waits on **all locks existing at reply
  time** — including the pending flush of N..M (locked earlier, at write time). Flush success →
  reply released → facet may persist cursor=M: safe, those rows are already durable and can never
  be rolled back. Flush failure → gate broken → the wait rejects → the facet receives
  `broken.outputGateBroken`, not data.
- parent→facet push: the outgoing call itself is parked caller-side
  (`worker-rpc.c++:368-372`); on flush failure it is never delivered.

So the facet can only ever durably record a cursor over a **flush-confirmed prefix** of the
parent's log. SQLite-rollback offset reuse after a failed commit can only affect rows the facet
never saw. Note the ordering subtlety honestly: the transitive abort (A.4 step 4) alone would be
racy — a facet could persist its cursor in the window between observing data and the abort
propagating. It is the _reply gating_ that closes the window; the abort is the cleanup, not the
guarantee. Corollary for our design: keep the parent's event append on the default confirmed
path (no `allowUnconfirmed`), and nothing else is required — the platform ordering does the rest.

(One non-hazard to note: `callPipeline` capabilities are fulfilled before the gated reply
(`worker-rpc.c++:1222-1227`), but pipelined operations only deliver _capabilities_; any data they
return flows through another gated reply, so no unflushed state can leak that way either.)

---

## QUESTION B — workerd #6800: SQLite facets pin the parent "idle, non-hibernatable"

### VERDICT B: NOT fixed upstream; pinning = any live facet "client" (and, in production, SQLite-facet storage specifically); the rule for us is **deterministically `ctx.facets.abort(name)` every facet when it quiesces, and never park facet stubs in long-lived parent state**

### B.1 Issue status — unfixed as of main @ 479771c30 (2026-08-18)

- Issue [cloudflare/workerd#6800](https://github.com/cloudflare/workerd/issues/6800), filed
  2026-06-05 by `powfan`: **OPEN, zero comments, zero linked PRs**; the only timeline event is a
  subscription (2026-06-16). No maintainer response exists in the issue itself — so no upstream
  "owner's verdict" to lean on; the "we must make sure we don't trigger this" verdict is our own
  project owner's, and this report confirms it is still necessary.
- No commit in workerd history references 6800 (`git log --all --grep=6800`: empty); no change to
  the `hasClients` logic since (`git log -S hasClients --since=2026-01-01 -- server.c++`: empty);
  nothing facet-hibernation-related in `server.c++` since May 2026. Related issues
  [#6087](https://github.com/cloudflare/workerd/issues/6087) (Hibernatable RPC Targets) and
  [#6702](https://github.com/cloudflare/workerd/issues/6702) are also both still OPEN.

### B.2 The issue's measured facts (production, from the issue body)

| Scenario                                                                            | GB-sec/trigger | parent wall time                      |
| ----------------------------------------------------------------------------------- | -------------- | ------------------------------------- |
| No facets                                                                           | 0.01           | ~0.08 s                               |
| 1 empty facet, **no SQLite**                                                        | 0.08           | ~0.6 s                                |
| 4 facets **with SQLite** (drizzle `migrate()` in `blockConcurrencyWhile`), no abort | ~1.0           | **~70–140 s (until forced eviction)** |
| same + `ctx.facets.abort()` after use                                               | 0.41           | ~3.2 s                                |

I.e. an un-aborted SQLite facet keeps the parent in "idle, in-memory, non-hibernatable" — it never
reaches the cheap ~10 s hibernation, and idle time converts to billed duration until forced
eviction. Our increment-29 e2e (facet-enabled DOs evicted at ~300 s on workers.dev, same as bare)
is consistent: **eviction still happens**, so the exposure is bounded per idle episode — the cost
is the billed window between last work and eviction, plus a 28.6 %→0.008 % error-rate difference
the issue reports at scale.

### B.3 What triggers the pinning (workerd-source mechanics)

The exact production supervisor check is closed-source, but the OSS semantics it mirrors are:

- `ActorContainer::hasClients()` recurses over the whole facet tree:
  `if (isShared()) return true; for (auto& facet: facets) if (facet.value->hasClients()) return true;`
  — `server/server.c++:583-590`. A facet is "shared" whenever any `ActorChannelImpl` to it is
  alive, because the channel holds a strong `kj::Own<ActorContainer>` —
  `server.c++:1628-1660`.
- Every `ctx.facets.get()` mints a `Fetcher` whose `FacetOutgoingFactory` lazily creates and then
  **caches** such a channel (`api/actor-state.c++:980-1025`, cache at `:1018-1024`); the factory
  is owned by the parent actor's IoContext (`ioCtx.addObject(kj::mv(factory))`,
  `actor-state.c++:1099`). So the channel — and therefore the facet's "client" status — persists
  until the Fetcher is GC'd or the parent actor is torn down. GC is nondeterministic: merely
  dropping the stub is not a reliable release.
- In workerd-local, `hasClients()` gates the 70 s container-erase loop
  (`cleanupLoop`, `server.c++:1593-1626`), while each actor (root and facet independently) is
  destroyed by its own 10 s inactivity timer (`inactive()` → `handleShutdown`,
  `server.c++:544-560`, `:1034-1077`). Parent hibernation does **not** tear facets down: the
  parent's `handleShutdown` destroys only the parent's `Worker::Actor`; facet _containers_ stay in
  the map (they die only via `monitorOnBroken`, `abortFacet`, or container destruction —
  `server.c++:520-536`) and facet actors wind down on their own timers. Production inverts this:
  per #6800 the parent cannot even reach hibernation while an un-aborted SQLite facet exists —
  the issue author's data isolates **facet SQLite storage** as the trigger (empty facet without
  SQLite ≈ fine), i.e. in production the facet's storage client itself appears to count as a
  client of the tree. That distinction is invisible in OSS source; what is visible is that
  _nothing in the current code releases a facet's client status while any channel or storage
  user is alive, and no idle timer ever aborts a facet_.

### B.4 What `abort()` does, and why it un-pins

- JS surface is exactly `get / abort / delete / clone` — there is **no** lighter
  `release()`-style API (`api/actor-state.h:463-489`; `DurableObjectFacets::abort` →
  `FacetManager::abortFacet`, `actor-state.c++:1104-1107`).
- `abortFacet(name, reason)` aborts the facet's actor **and erases its container from the facet
  map** — `server/server.c++:745-750`. Erasure is the un-pin: the parent's `hasClients()` no
  longer recurses into it, and outstanding stubs point at a hollowed, broken container that no
  longer counts. Abort recurses into the facet's own children (`server.c++:684-686`).
- Abort does **not** touch durable state — only `deleteFacet` removes the facet's SQLite files
  (`server.c++:752-764`, file removal `:915-922`). A subsequent `facets.get(name)` builds a fresh
  container/actor over the surviving storage (`getFacetContainer` `findOrCreateEntry`,
  `server.c++:714-737`). Cost per the issue: full constructor + `blockConcurrencyWhile` +
  migrations, ~50–700 ms.

### B.5 Concrete rules for our design (Stream DO parent + cursor/fold facets)

1. **Abort on quiesce, from a parent idle path.** When a facet's delivery is caught up and it has
   no in-flight work, the parent must call `ctx.facets.abort(name, reason)` (e.g. from the same
   idle bookkeeping that already debounces delivery, or a parent alarm). This is the _only_
   mechanism that exists — nothing upstream fixes this, no hibernation of the parent will do it
   for us, and waiting for stub GC is nondeterministic.
2. **Never park facet stubs in long-lived parent state.** Re-`facets.get(name)` per delivery
   burst; the container is reused while live (`findOrCreateEntry`) so re-getting is cheap. Every
   retained `Fetcher` is a strong pin (B.3) independent of the SQLite issue.
3. **Keep facet construction cheap**, because rule 1 makes re-materialisation the steady state:
   version-guarded schema setup, no heavy per-wake `blockConcurrencyWhile` migration. Budget the
   issue's measured 50–700 ms reconstruction into wake latency.
4. **Safety interaction with Question A: aborting an idle facet is loss-free.** The cursor+fold
   live in the facet's durable storage; everything the facet ever observed was flush-confirmed
   parent state (Verdict A), so abort-then-rebuild resumes exactly at the durable cursor.
5. **Don't rely on eviction as the mechanism.** It does bound the damage (~300 s observed in
   increment-29, 70–140 s in the issue), but between quiesce and eviction the parent bills
   duration at full memory footprint, and the issue's fleet data (0.33→1.0 GB-sec/trigger, 28.6 %
   errors) shows this compounds badly under sustained triggering.
6. **Watch #6800/#6087 before removing the abort logic.** If Cloudflare ships facet-aware
   hibernation (or hibernatable RPC targets), rule 1 can be revisited; today the issue is open,
   uncommented, and unpatched.
