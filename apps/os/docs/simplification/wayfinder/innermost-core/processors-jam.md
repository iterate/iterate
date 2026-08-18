# Processors jam v5 — grounded in apps/os, simplified where the ground allows

v5 after seven annotations on v4, two of which were an instruction: _ground this in what
apps/os has today and find a simpler model that is equally expressive_, and _ephemeral events
are a must_. Two mapping passes over apps/os back everything below (`stream-event-sender.ts`
2485 lines, `stream-durable-object.ts`, the runner, the ephemeral buffer, and the three
delivery-latency commits on `stream-for-audio`). Where v4 guessed, v5 cites.

The headline: **your annotation-5 instinct — "just call `processEventBatch` on the facet; wake
is the thing that makes a far-away subscriber connect" — is almost verbatim the apps/os
hosted-connection model.** The stream dials a cold processor once; the processor hands back
`{checkpointOffset, processEventBatch}` (a callback stub); pushes then flow over that live
connection, results returning on a separate one-shot callback (awaiting the push return can
deadlock two DOs). v5 adopts that shape and deletes v4's facet-nudge framing.

## What apps/os actually has (the ground)

**Five receiver kinds** (`SubscriptionReceiver`, core-processor-contract.ts):

| kind              | cursor owner                                                          | delivery                                                      | OURS (owner verdicts, this round)                                |
| ----------------- | --------------------------------------------------------------------- | ------------------------------------------------------------- | ---------------------------------------------------------------- |
| `facet-processor` | consumer (runner's own KV, CAS-fenced)                                | stream dials facet in-process; pushed batches over a callback | THE processor row — for now ALL processors are facets            |
| `wake-processor`  | consumer                                                              | same, but the dial is an itx expression                       | **deleted for now** (remote deferred — see the circularity note) |
| `itx-call`        | **stream** (SQLite cursor row; the awaited call resolving IS the ack) | one batch in flight, loop until caught up                     | push mode, the general case                                      |
| `webhook-post`    | **stream**                                                            | HTTP POST, batch size 1                                       | push mode, target = an egress fetch expression                   |
| `copy-to-stream`  | **stream**                                                            | append into another stream                                    | push mode, target = another stream's append                      |

- **Configuration is event-sourced into the fold; cursor rows are projections, not truth**
  (rows whose name left the fold are deleted on every pass). Exactly v4's rows-as-events +
  derived-index shape — already proven there.
- **Live sessions/browsers are NOT rows.** In-memory connections only; "they own no durable
  cursor, so a hole costs them nothing"; the client replays after ITS OWN offset then goes
  live. (Annotation 3 answered: apps/os agrees with you — the server does not track what a
  browser has seen.)
- **The commit path never awaits delivery.** Append → SQLite insert → synchronous `sendDue`;
  real sends ride an alarm boundary (outside an alarm turn, `setAlarm(now)` and return) to
  break the append↔delivery↔caller cycle.
- **No dead-letter queue exists.** The real ladder: backoff retries (1s·2^n, cap 30min, ±20%
  jitter, 15 attempts ≈ 2h), poison-event isolation (`onFailingEvent: "skip"`: 3 isolated
  failures → skip + audit event), then **halt** — event-sourced, resumable
  (`resumeSubscription`, `setSubscriptionCursor`). Simpler than a DLQ and fully auditable.
- **The stateless worker is not a special mechanism** — it is an ordinary `itx-call` push
  subscription named `project-worker` targeting `["processEventBatch"]`, `onFailingEvent:
"skip"`. The author subclasses the SDK entrypoint and writes `processEvent(event)`; throwing
  redelivers; the stream owns offset/retry machinery. (Your "must-support" case: confirmed, and
  it is one row, not a subsystem.)
- **Stub disposal** (the "super important to retain" code): every fire-and-forget push runs
  `disposeIgnoredRpcResult(result)` — an unused RPC return is still a disposable stub and leaks
  the remote reference otherwise; apps/os repeats the discipline at eight early-exit points on
  the wake path.

**Ephemeral events** (the must-have, as shipped):

- An envelope field: `ephemeral: true` (with `idempotencyKey` rejected — nothing idempotent
  about the unreplayable). Bodies live in a 10 MiB FIFO memory buffer; **the whole buffer dies
  with the incarnation, by design** ("an ephemeral event's body cannot be redelivered by
  anyone").
- **One shared offset sequence.** Ephemerals consume offsets; after reboot their offsets remain
  as _valid gaps_. Consumers advance on **scan-window proof** (`scannedAfterOffset` /
  `scannedThroughOffset`), not by counting events — that one mechanism makes ephemeral holes,
  filters, and reboot gaps all the same non-event.
- **Almost zero writes — deliberately not zero:** a pure-ephemeral append performs exactly one
  tiny SQLite write, the `stream_metadata` highest-assigned-offset update, because that is the
  only thing preventing offset REUSE after the incarnation dies (a reused offset with a
  different body hard-aborts browser stores). Everything else about the append is memory.
- **Who sees them:** live sessions always; processors only by NAMING the type in `consumes`
  (`"*"` never sweeps ephemerals); stream-cursor push kinds never (their cursor still
  advances). Folds MAY reduce them, and a rebuild silently omits them — the written rule is
  "never derive durable product truth from an ephemeral event" (chunks fold into live UI state;
  the settled durable fact carries the full text).
- **The delivery-latency trilogy** (the 2026-08-17 fixes, our design-ins rather than
  retrofits): (1) all-ephemeral batches ride **uninsured** — no in-flight SQLite writes, no
  alarm write; liveness comes from a wedge-check in the send loop instead; (2) **coalesce** —
  batch limit is a function, not `=1`; 225 batches for 194 events was the smoking gun; (3)
  **pipeline** uninsured batches back-to-back, bounded at 4 in flight. Recorded effect: uplink
  lateness p90 188ms → 38ms; ~700ms shaved off a ~1900ms press-to-answer.
- **Durability modulation that exists:** fold checkpoint debounced (every 64 events or 1s —
  event rows are truth, boot folds past a stale checkpoint); runner commits once per delivered
  batch (the deliberate at-least-once replay window); alarm writes deduped (`armNoLaterThan`).
  Known cost hole pre-fix: hosted delivery spent ~2 SQLite writes + an alarm write per event.

## The clean-room model (simpler, same expressiveness)

**Two subscription modes, not five kinds.** The three stream-cursor kinds differ only in what
they call — which is exactly what an itx expression says. So:

| mode          | cursor                            | the row                                                          |
| ------------- | --------------------------------- | ---------------------------------------------------------------- |
| **processor** | consumer-held                     | `{name, target: <expr resolving to the processor>, consumes}`    |
| **push**      | stream-held (+ retries/skip/halt) | `{name, target: <any itx expression>, consumes, onFailingEvent}` |

`webhook-post` = a push row whose target is an egress fetch expression. `copy-to-stream` = a
push row targeting `itx.streams.get('/other').append(...?)`. `itx-call` = the general case.
The stateless `processEvent` worker = a push row targeting the project worker. One retry/skip/
halt ladder serves them all (no dead-letter — apps/os proves halt+skip+audit suffices). The
jsonata transform does not come over; a transform is a real function in the config worker.

**Delivery, one mechanism (annotations 5+6 resolved):**

- **THE PUMP lives in the stream** — the only sender. After a commit it pushes
  `processEventBatch(batch, window)` to every current connection, in order, fire-and-forget,
  disposing each push's returned stub. There is no separate per-subscriber "catch-up loop"
  competing with it — what v4 called that is only **gap repair**: a subscriber that boots (or
  sees a non-contiguous window) reads once from its own cursor, then rides pushes again.
- **A facet IS a connection that never dials.** The parent pushes `processEventBatch` straight
  into the facet on every commit — the call itself loads the durable object; no nudge concept,
  no wake for facets, ever. Contiguity rides the same scan-window proof.
- **Remote processors: DELETED for now (owner verdict) — all processors run in facets.** The
  circularity worry that motivated the cut, recorded for when remote returns: if a processor
  row's placement is an itx expression, resolving it needs the routing table — which lives in
  the iterate-context facet, which is itself a subscriber the pump must reach. The recorded
  way out: processor rows are `{slug}` only (the facet base case, parent-private, no table
  consulted on the delivery path ever); a future remote row would resolve its expression only
  at subscribe/reconnect time (cold path), never per commit. Until a real remote processor
  exists, none of that is built.
- **Browsers:** live connections, no rows, no server-held cursor; the client says "everything
  after 75" on reconnect. (Server-held per-tab cursors: rejected — apps/os agrees.)

**Ephemeral events, clean-room requirements (annotation 1):**

- Envelope `ephemeral: true`; memory ring with byte cap; shared offset sequence; scan-window
  delivery. Adopt the ONE deliberate write (highest-assigned-offset) with its rationale stated
  — or accept offset-reuse-after-reboot and delete even that; recommend adopting it, it is one
  tiny UPDATE per append _batch_, and offset reuse is a data-corruption class.
- **Zero fold/cursor writes on ephemeral-only activity**: uninsured push batches, coalescing,
  bounded pipelining from day one (the trilogy as design, not retrofit); fold checkpoints
  debounced and NEVER triggered by ephemeral-only deltas; processor progress commits only when
  a window containing durable events completes.
- Reduce may fold ephemerals; rebuilds omit them; the divergence rule is stated in the SDK
  docs ("never derive durable truth from an ephemeral event") and the runner makes the
  eventless rebuild-vs-live difference visible in `getRuntimeState`… which no longer exists —
  so: visible in `snapshot()`'s offset honesty (it reports the durable fold offset).

**Expression-valued arguments are strings (annotation 7):** no grammar change.
`itx.workers.get({ type: 'stateful', source: "itx.files.read('/heavy.js')", className:
'Heavy' })` — the receiving root parses the string as an expression (it already accepts either
codec half). v4's call-by-value idea dies: the receiver _wants the name_, not the value.

## Still standing (decided)

- The collapse: registry → SDK base class (TypeScript, prebuilt); authors write
  `reduce`/`processEvent`; read surface = `snapshot()` + `waitUntilProcessed` (kept: in
  apps/os it is ONE uniform verb split by kind — processor kinds relay to the runner's
  barrier, push kinds park a waiter on the row's confirmed cursor; same split here).
- Facets host durable objects; the facet address (`facetInvoke` + the native fetch/101 door);
  `enableProcessor` dissolves into `subscribe`.
- `roots` naming still open (behavior settled); ITX-vs-STREAM identity still open.

## Increment plan v5

1. **Collapse + SDK** (unchanged scope, minus every `deliver`/nudge naming).
2. **The pump + processor mode:** push `processEventBatch(batch, window)` into facets
   per commit; scan-window contiguity; gap repair on boot; ephemeral envelope + memory ring +
   the one metadata write; **the #6800 quiesce rule (see B7): caught-up idle facets are
   `abort`ed from the parent's idle path — storage kept, next burst rebuilds loss-free — and
   facet stubs are never retained across bursts**; live proof: a voice-shaped ephemeral flood
   folds into a facet with ZERO fold/cursor writes and byte-identical durable refold, plus an
   idle context whose facets abort and rebuild.
3. **Push mode:** stream-held cursor rows + retry/skip/halt ladder; the stateless
   `processEvent` worker proof; per-push disposal.
4. **The facet address** (as before).
5. **Deferred:** remote wake connections (the shape is fully specified above; built when a
   remote processor exists).

## Open questions v5

1. Go on increments 1–4?
2. The one deliberate metadata write on ephemeral appends: adopt (recommended) or pursue true
   zero-write with offset-reuse risk?
3. Ephemeral opt-in for processors: apps/os requires NAMING the type in `consumes` (`"*"`
   never sweeps ephemerals). Keep that rule verbatim?
4. `waitUntilProcessed` kept as the one barrier verb (split by mode, as apps/os) — confirm?

---

# Appendix A — where the whole clean room stands (comment here on the plan)

Deploy `lessons-1`, 74/74 tests, all three live proofs green, 32 build-log increments pushed.
**3,412 lines of product code in 18 files** (+1,007 test lines): expression codec 629, the
Stream DO 450, processor layer 446 (~276 of it the registry scheduled to die), capnweb edge
311, routing table 263, facet spine 231, don't-pin transport 284, the rest ~800. For scale:
apps/os's delivery machinery alone (`stream-event-sender.ts`) is 2,485 lines.

**The build plan** (from this jam; sizes are estimates):

| #   | increment                          | net lines      | content                                                                                                             |
| --- | ---------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------- |
| 1   | Collapse + SDK                     | ~−150          | registry → base class; TS SDK prebuilt + injected; user-tally 17→8 lines; −3 concepts                               |
| 2   | Pump + processor mode + ephemerals | ~+300          | ephemeral ring + the one metadata write; scan-window pushes into facets; uninsured/coalesced/pipelined from day one |
| 3   | Push mode                          | ~+250          | stream-held cursor rows + retry/skip/halt; the stateless `processEvent` worker; per-push disposal                   |
| 4   | The facet address                  | ~+70           | `facetInvoke` + `roots.facets` + one seed                                                                           |
| —   | Remote wake connections            | +~150 deferred | built when a real remote processor exists                                                                           |

Recommended sequencing: 1+2 together (same files, renames once), then 3; 4 anytime.
End state ≈ 4.0–4.3k lines with ephemerals, push subscriptions, facet addressing, and the SDK.

# Appendix B — the Kenton cross-reference DISCUSS list (7 owner calls; comment inline)

From `packages/v3/project-worker/research/kentonv/lessons-for-clean-room.md` (28 lessons; 19
already aligned, 2 applied in `lessons-1`). Each item below needs a verdict from you.

## B1. The `?ctx=` front door is designation without introduction

Anyone can mint a session for any project by naming it in a query param — the
CORBA-global-namespace shape Kenton's five-reasons critique attacks. Everything BEHIND the door
is ocap-clean. Acknowledged clean-room scaffolding.
**VERDICT (owner) → DONE in `verdicts-1`:** implement `.authenticate()` now as a NO-OP — call
it on the main RPC stub, get an authenticated session. Shipped: `ProjectSession.authenticate
(credentials?)` returns the session; clients go `session.authenticate(...).get()/.connect(...)`;
the real check lands in that method later without changing any caller. Live proof green.

## B2. A facet's fold could outrun the parent's durability

If parent→facet replies are not covered by the parent's output gate, a facet could durably
persist a cursor past a parent commit that later FAILS to flush — and SQLite's autoincrement
rollback means the reused offset's different event is silently skipped. Rare (a failed durable
flush), but it violates "a cursor is only ever behind durable truth."
**VERDICT (owner):** ok to (a). **RESULT — the hazard is IMPOSSIBLE** (workerd source, main
@479771c30; `research/facet-gating-and-idle-billing.md`): the parent's output gate treats
facet↔parent traffic as fully external — outgoing calls park caller-side until the gate opens,
and the parent's RPC replies to a facet's loopback reads park callee-side after the handler
returns; SQLite writes lock the gate and a failed flush BREAKS it. A facet can never durably
record a cursor over anything but a flush-confirmed prefix. Conditions we already satisfy: no
`allowUnconfirmed` (raw `sql.exec` can't even opt in), and facet↔parent data flows only over
RPC. No `storage.sync()`, no epoch stamps — the design was already safe.

## B3. Attenuation is per-context, not per-client

Every holder of a project session sees the project's whole table; narrowing happens by giving a
subordinate its own context (cheap here), not per-session views of one context. This is exactly
where Kenton honestly scores his own bindings ("not a complete capability system") — plus the
audit/revocation log he wished for.
**VERDICT (owner) → CLOSED:** "absolutely deliberate — everything in a project is trusted to do
everything in a project." Context-granularity attenuation is doctrine.

## B4. Per-context loader cacheKeys multiply ~5MB isolates

Confinement bakes the owning host into each isolate (`env.ITX` + `globalOutbound`), so N
contexts running the same source hold N isolates at ~5MB each. Kenton's platform hit the same
tension and solved it with parameterized entrypoints (authority in per-call props, one isolate
serves many principals).
**VERDICT (owner) → ESCALATED, addressed:** "extremely important… the cache key for the dynamic
worker loader is one of the most sensitive cost levers in the entire system" — confirmed by
apps/os PR #2504: a per-request nonce in the key minted ~3.9M distinct loader identities ≈
**$7.8k in ~3 weeks** (every distinct `LOADER.get` key bills $0.002/worker/day) plus a cold
~5MB isolate build per dispatch. The clean room's keys are already low-cardinality (deploy ×
context × content hash, no nonces); `confinedWorker` now carries a LOUD comment stating the
pricing constraint and the binding-liveness tension the nonce papered over, so no future change
re-adds a high-cardinality component unpriced.

## B5. Depth budgets: mount recursion capped at 32, the JSON walks are not

substitute/hole-scan/jsonEqual/parser recurse without a cap. Cycles are impossible (parsed
JSON, no custom serializers), so the only exposure is stack exhaustion from deeply-nested input
by an authenticated project client; JSON.parse and workerd RPC bound much of it upstream.
**VERDICT (owner) → DONE in `verdicts-1`:** one shared non-resetting budget (`deeper`, cap 64)
now guards the parser's value recursion, substitution, the hole scans, and `jsonEqual`; +1 test
(70-deep nesting errs loudly in both halves).

## B6. Error classification by message regex

The fetch lane maps `/no capability matches/` → 404; greppable message text is house doctrine —
but that 404 silently depends on a sentence someone may innocently reword. capnweb 0.8.0 drops
`error.name` in transit, so typed errors would not survive the client hop anyway.
**VERDICT (owner) → RESEARCHED AND STOLEN in `verdicts-2`.** cloudflare-os
(github.com/cloudflare/cloudflare-os) uses plain `Error` + a `code` own-property via
`Object.assign`, defined once, read with `"code" in error` — never name, instanceof, or message
regex. That works because (runtime-verified) capnweb preserves ALL own enumerable properties
across the wire even though it coerces custom names and drops subclass identity — and workerd
stamps its own flags (`.retryable`/`.overloaded`/`.durableObjectReset`) on the same channel.
Shipped: `core/errors.ts` (`codedError`/`errorCode`); `NO_CAPABILITY_MATCH` +
`IDEMPOTENCY_CONFLICT` (+ `data.existingOffset`) wired; the fetch lane's 404 classifies by
code; message regex gone; human messages verbatim. Full findings:
`research/error-handling.md`.

## B7. Hibernation vs eviction — and what idle facets may bill

Our incarnation counter detects reconstruction (hibernation and eviction indistinguishably);
increment-29 growth was eviction-scale (~300s+). workerd #6800 says SQLite-backed facets can
hold the parent "idle, non-hibernatable" — converting idle sockets into billed duration until
the evictor arrives. The bill is the observable.
**VERDICT (owner):** "we must make sure we don't trigger this." **RESULT — #6800 is UNFIXED
upstream (open, zero comments/PRs as of 2026-08-18) and the pin is any live facet client:**
every `facets.get()` caches a strong container reference in the parent, nothing idle-releases
it, and parent hibernation does NOT tear facets down — production data in the issue shows
~2.4× GB-sec on an idle parent with an un-aborted SQLite facet. **The don't-trigger rule (now
an increment-2 requirement):** deterministically `ctx.facets.abort(name)` from the parent's
idle path once a facet's cursor is caught up — abort erases the container (un-pins), KEEPS the
SQLite storage, and the next `get()` rebuilds over it in 50–700ms; loss-free because of the B2
verdict above. Never retain facet stubs across delivery bursts (re-`get` per burst); keep facet
constructors cheap (re-materialisation is the steady state); treat eviction as damage-bounding,
never the mechanism. Full mechanics: `research/facet-gating-and-idle-billing.md`.

# Appendix C — other open naming/identity calls (restated so everything is in one doc)

- **The word `roots`** — behavior settled (host-only vocabulary, unspellable from event
  provenance); you remain unsure about the name.
- **ITX vs STREAM** — one concept or two from a caller's perspective; v5 spells addresses
  `itx.facets…` (one context = one stream) until decided.
- **REVIEW-KENTON leftover:** `ClientsView` reads return `unknown[]` (weakly typed for in-DO
  callers; a shared row shape would touch the Roots surface). Minor; annotate if you care.
