# The simplification hunt

23 agents (5 subsystem lenses, 5 concept collapses held seriously, 3 source mines over
cloudflare-os / capnweb / workerd), every simplify/collapse report adversarially verified
against the actual code before anything below survived. Framing was yours: _not whether it's
required — whether there's a simpler, better way; hold the problem every which way._ Security
out of scope by your order. Line anchors were checked by the verifiers; ~40% of raw findings
were killed.

## 1. Bugs the hunt found (fix regardless of any other decision)

1. **`print` unwraps `$`-escapes** — `print(["itx",["f",{$:{"?":0}}]])` yields `itx.f(?0)`,
   which re-parses to a LIVE hole where the mount had frozen data — the exact inversion `$`
   exists to prevent. Fix = delete the three-line literal arm; `{ $: ?0 }` then round-trips
   verbatim (probe-verified). The parse⇄print suite has no `$` case, which is why it survived.
2. **`skipsSinceSuccess` never resets on success** — "3 consecutive skips" is actually "3 skips
   ever since subscribe": skip, months of clean deliveries, skip, skip → HALT.
3. **The push ladder conflates poison with outage** — a plain 5-minute target outage on a
   `skip` row burns ~9 calls, sacrifices 2 innocent events, and halts in minutes, while a
   `halt` row rides the full 15-attempt ladder. The code contradicts its own header comment
   (which describes the intended SEQUENTIAL shape). Fix: ONE retry ladder to maxAttempts, and
   only at exhaustion consult `onFailingEvent`.
4. **`resolveFetch` silently drops JSON args on a call-step fetch terminal** — the exact
   silent-arg-drop `apply` exists to loudly reject. One guard line.
5. **Userspace facet source re-resolves on EVERY commit** — `#facet` runs
   `await this.invoke(ref.source)` + full module re-hash per push, even though the warm-facet
   callback is never invoked. Resolve at enable time, store modules under a per-slug key (and/or
   move resolution inside the `facets.get` callback, which workerd skips when warm).
6. **Alarm-woken cold DOs can throw in `#doName`** — `ctx.id.name` is undefined in alarm-woken
   DOs on runtimes before workerd's 2026-07-02 fix, and our push-retry alarm path reaches
   `#name.path` via `read()`. Fix: persist the name in `#touch()`, fall back to it.
7. **`#running` is dead state** — written twice, readable by no one (it's `#`-private).
8. **`assertMustUse` plumbs numeric holes it then ignores** — collect named captures only.

## 2. Verified simplifications (adversarially confirmed simpler-better)

**Codec.** Merge `usesCallerArgs` into `substitute` as a returned `spentArgs` flag (deletes the
THIRD hole-walker and its third spread-detection spelling — the drift class that already
shipped one bug). Make rest-splice explicit (`...?n` = `args.slice(n)`; bare `...?` legal only
with no numeric holes in the list — kills the inference the increment-26 bug lived in, and the
`...?1`-parses-but-means-object-copy overload). **Owner memo:** specificity could collapse from
per-step arrays to ONE integer ("binds the most wins; ties newest") — every shipped mount picks
the same winner, but there is a real divergence class (a newer hole-y alias can tie a literal
mount under sum where lex strictly orders them) — your call, documented either way.

**Wire.** `invokeCapability` leaves the wire entirely: it is a 4-line client-side desugar into
the ONE dispatch verb (`invoke`), the codebase already desugars exactly this way in two other
places, and the name currently puns across three incompatible contracts. The four edge client
classes (ClientCollection/Client/ClientConnection) are server-hosted expression builders —
replace with client-side typed builders (~−70 lines; latency is a wash, capnweb already
pipelines). `parkClient`/`parkCapability` = one `park` verb (and `connect()` without
capabilities is today a silent presence no-op contradicting the file's own header).

**Transport (the strongest structural cut).** Carry the call ON the pager socket — delete the
wake→activate→borrowed-Invoker-leg handshake entirely: the pending map only ever has entries
while an inbound call is in flight (which already blocks hibernation), so the three-phase dance
buys nothing the socket itself can't carry; UUID callIds make stale frames harmless. Stamp stub
meta on the pager UPGRADE request (park-as-a-phase dies; today's `parkCapability` visibility
literally depends on structured-clone preserving an undefined-valued key). The five-verb stub
facade is a FOSSIL of the increment-21→22 migration (its semantics moved into the ictx facet
but the verbs stayed parent-side); it shrinks to 3-4 primitives. `dup()`'s `?? invoker`
fallback silently converts a missing dup into retain-after-dispose — dies with the handshake.

**Loaders.** Fold the stateful-worker runner INTO the Stream DO as a facet — one DO class total
(every duplicated pattern verified line-for-line, and the runner currently escapes the #6800
quiesce). Merge stateless run/fetch into one wrapper/one isolate/one billed identity. Mint
cacheKeys INSIDE `confinedWorker` with a closed kind union — one audit point for the dollar
lever. Drop `workers.get`'s `type` discriminator (`className` presence already decides; both
invalid states become unrepresentable). Generate the injected runner from real TS via
build-sdk (the hand-mirrored duck contract is exactly the drift this repo's history punishes).

**Storage.** The kv high-water mark is transactionally authoritative — delete
`#eventsTableExists` and the SQL leg of `#maxAssigned`. `storage.kv.list({prefix})` exists now:
per-name `sub:*` / `proc:*` rows instead of whole-array rewrites.

## 3. The concept collapses — your open questions, answered

**ITX vs STREAM: ONE concept. Adopt the rename.** (Verdict: holds.) The machine already
believes it — the binding is named CONTEXT, roots.ts says "a stream IS a context", and the
runtime hands back a FULL DO stub that expressions can already walk. Kill `itx.streams`; add
`itx.log` (own log — the commonest write becomes dotted-door spellable, which is exactly why
`Itx.invoke` had to exist) and `itx.contexts` (siblings as full ROUTED contexts — which makes
your closed B3 attenuation doctrine _spellable_: `provide({pattern:'itx.bot',
target:"itx.contexts.get('/agents/bot')"})` is a named, shadowable, revocable whole-agent
handle). One new rule surfaced by the reframe, worth writing on the wall: **doors you need when
routing is broken must not route** — revoke-by-offset, unrouted log read, unrouted table
snapshot stay native forever. (The "make every edge verb a seed" extension was killed:
complexity moved, not removed.)

**Four tables or one: NEITHER — two kinds of truth.** (Verdict: one-STORAGE reading killed —
including by a bootstrap impossibility: iterate-context is itself on the fan-out list a
fold-held table would put inside iterate-context. One-CONCEPT reading adopted.) The rule the
code already follows everywhere: **CLAIMS (immutable, expression-shaped, event-worthy) vs
PROGRESS (mutable registers), and a progress register lives in the storage of the engine that
advances it.** The five stores are claims × engines, not duplication. Corollary insight: a push
subscription and a facet processor are the SAME concept — a standing delivery — differing only
in cursor CUSTODY; the ladder and gap-repair are the same at-least-once obligation seen from
the two custodians. And the acceptance test for any future "one table" pitch: a store resists
unification exactly when its truth is not expressible as an expression (socket liveness,
cursor position, config text).

**roots: DELETE THE OBJECT — the naming debate deletes itself.** (Verdict: holds.) The
RpcTarget shell has been vestigial since increment 28 (never crosses a hop; the tests fake it
with object literals). Replace `Roots`/`buildRoots` with a plain record whose KEYS are the
expression roots, spread into config-provenance scope (`{...hostScope, itx}` — itx LAST, plus
a builder assert that `itx` is never a key). `provide`'s check becomes `target[0] !== "itx"`;
seeds read `kv`, `log`, `bindings.get('FALLBACK')`; tighten `evaluate`'s root lookup to
`Object.hasOwn` in the same commit. The provenance gate was never an object — it is a
scope-KEY-SET decision, and it must live at evaluation (the smuggled-event test passes
literally unchanged). Net ≈ −80-100 lines, one framework noun, and the whole naming question.

**capnweb-in-the-DO: DEAD (your ruling; the hunt strengthens it).** The session-killing event
isn't eviction — it's the **10-second hibernation timer** (increment 19 measured ~one
reconstruction per 26s on an idle kilo-client DO); DO-tier sessions die ~30×+ more often than
edge sessions. But the rule should be REWRITTEN so it stops inviting this attack: not "capnweb
never terminates in a DO" but **"capnweb session state is live JS; it may only live in the
CPU-billed, freely-reconnectable tier, never a duration-billed evictable one."** And label
hibernatable-pager/stub as a **capnweb #36 polyfill, scheduled for deletion by upstream** —
when workerd ships Kenton's plan, ~290 lines delete for free in the CURRENT architecture,
which strictly dominates the reframe.

**Subscribing IS providing — adopt the storage half, refuse the broadcast half.** (Verdict:
partial.) A subscription = a mount at `itx.subscribers.<name>` (the capability-provided event
carries the delivery policy in its payload) + **the irreducible residue: the cursor** — which
is why `resumeSubscription`, the one cursor-surgery verb, survives verbatim. This fixes a real
divergence: push rows are today silent-kv config in a system that event-sources every other
claim. Cursors keyed by `providedAtOffset` give **freeze-and-fork wiretap semantics** for free
(shadow a subscriber → original's cursor freezes; revoke → it resumes exactly where it
stopped; revoke doubles as cursor GC). Two hard corrections from verification: the parent
folds its fan-out projection INLINE in `append` (it sees every event body at the commit
point — no facet round trip, no cache), and the pump delivers **by row identity, never by
name through the table** (a broad default route must not intercept deliveries). Facet rows and
parked clients stay out, for the recorded circularity/transport reasons.

## 4. What we're not considering (the mines)

**From workerd — the platform moved under us (biggest items):**

- **`ctx.props` / per-entrypoint props are usable TODAY** — `confinedWorker` can stop baking
  `env.ITX` per context: `loader.get('shared:${deploy}:${contentHash}')` +
  `getDurableObjectClass('Runner', {props})`. Loader cacheKeys collapse to deploy × content:
  ONE isolate serves every context — the PR-2504 "shape to steal", shipped.
- **`ctx.exports.ProcessorFacet({props})` deletes `configure()`/`FacetIdentity` entirely** —
  the header comment "a facet cannot receive constructor args" is now FALSE. Facets read
  `this.ctx.props`; the first-contact handshake, the durable identity kv, and the
  enable-ordering constraint all die.
- **`unsafe.evict(stub, {webSockets:'hibernate'})`** — deterministic CI proof of don't-pin,
  attachment-derived stubs, and cursor gap-repair. Every death-related invariant currently
  proven by _waiting_ becomes a fast local test lane.
- **`facets.delete` / `facets.clone`** — `disableProcessor` (currently MISSING: the only
  off-switch for a misbehaving userspace processor is hand-editing kv) and pre-upgrade
  fold backup/rollback.
- **`setWebSocketAutoResponse` pairs + per-socket timestamps** — pager liveness with zero DO
  wakes; `/state` gains honest `lastSeen` per stub.
- **`ctx.exports` loopback** — SOLO mode loses its self-referential FALLBACK service binding
  (config-free), and the `(ctx as {exports})` cast dies via `wrangler types`.

**From capnweb — the library does things we hand-roll or ignore:**

- **`newWorkersRpcResponse` serves BOTH WebSocket and one-shot HTTP batch** — today every CLI
  script/cron/webhook must do a WS handshake for one call. One-line change at `/api` (batch
  sessions just can't `connect`/provide-live — throw clearly).
- **`Symbol.dispose` on ProjectSession + `onRpcBroken` on retained providers** — today when a
  client's socket drops, the relay's parked stubs persist and the roster LIES until an invoke
  hits the 10s attach timeout. Two small edits delete our hand-rolled staleness discovery.
- **The commissioned Upgrade-Response-over-RPC fork feature is installed and UNUSED** — `/cap`
  can collapse into `/api` for capnweb clients (`Itx.fetchCap(cap, request)`, 101 rides the
  session).
- **Flow-controlled stream serialization** (`WritableStream` over the wire) — the voice/board
  firehose lane (`Itx.appendStream`) instead of an awaited RPC per ephemeral append; the
  entire PTT-overhead saga was symptoms of per-call framing.
- **`expr((itx, hole) => itx.grok.chat({model:'grok-4', messages: hole()}))`** — record a
  lambda against a capturing proxy (capnweb's MapBuilder pattern) → emit our canonical
  Expression. Typed, IDE-completed expression authoring; the string half becomes display
  format rather than the only authoring surface.
- **`serialize()/deserialize()` for event bodies** — `JSON.stringify` at the commit point
  silently mangles Dates/bytes/Errors arriving rich through capnweb. Minimum: validate loudly.
- Verdict on `.map()` remap vs our codec: NOT a reinvention — remap is a per-element lambda,
  ours is a routing table. Steal the two mechanisms above, keep the codec.

**From cloudflare-os — Kenton's own platform, structurally different choices:**

- **Capability handles are loopback WorkerEntrypoints with props sealed in** — the stub IS the
  address; no routing table for plain wiring. His shape for "this worker sees SLACK" is an
  embedded `bindings: Record<name, ref>` per consumer — patterns buy nothing there. Our table
  earns rent ONLY for the agent-facing namespace (override/shadow/revoke) — worth splitting
  the two jobs.
- **`ctx.restore` + storing restore-params validates our mounts-as-expressions design** — his
  platform stores the capability, but by storing _how to rebuild it_ (target-chosen params) —
  we store the same thing with a central grammar. Convergent; ammunition, not a change.
- **Durable delivery state only for consumers that cannot re-pull** — browsers/facets that can
  re-read get ZERO rows (client-held resume tokens + a streamGeneration stamp). Matches our
  browser doctrine; suggests pager-fed subscriptions shouldn't hold stream-side cursors either.
- **One-alarm resurrection: a REAL GAP of ours** — a batch interrupted by eviction with no
  subsequent traffic resumes only when the next event arrives. His pattern: in-flight work ⇒
  one alarm + durable marker ⇒ constructor/alarm scans behind-cursor rows and resumes. We get
  the marker free (cursor < maxAssigned).
- **The 2×-amortized snapshot rule** — snapshot when log-since-snapshot exceeds the last
  snapshot's size: self-tuning, zero knobs, bounded storage and replay. Answers a cadence
  policy we still owe.
- **No generic dispatch door exists at all** in cloudflare-os — small typed capability trees +
  "code is the only composition language" (our config-worker escape hatch, elevated to the
  whole answer). Evidence for trialing a typed `{log, clients, facets}` root where `invoke`
  is the config/agent path, not the everyday path.

## 5. Proposed sequencing (if you bless the lot)

1. **Bug sweep** (§1, all eight — small, no design decisions).
2. **The three adopted collapses as one arc:** no-roots flatten → stream-is-itx rename
   (itx.log/itx.contexts + the recovery-kit carve-out) → subscribe-as-provide (event-sourced
   subscriptions, providedAtOffset cursors, identity-addressed delivery). Each is small; each
   deletes a concept AND an open question.
3. **Transport cut** (call-on-the-pager + meta-on-upgrade + facade shrink).
4. **Loader unification** (runner-into-stream facet, one wrapper, cacheKey mint, ctx.props
   spike — the props change also deletes configure()).
5. **Edge adoption pass** (newWorkersRpcResponse, Symbol.dispose/onRpcBroken, fetchCap,
   kv.list rows, disableProcessor via facets.delete, auto-response liveness).
6. **The `unsafe.evict` test lane** (turns every waiting-proof into CI).
7. Deferred flavors: appendStream firehose, expr() authoring helper, snapshot cadence rule,
   one-alarm resurrection, serialize-at-commit.

## 6. Decisions only you can make

1. Specificity: collapse to one integer (with the documented tie-widening change) or keep lex?
2. The typed-root trial (cloudflare-os's zero-generic-door evidence) — explore or park?
3. Split the table's two jobs (agent namespace vs plain consumer wiring via embedded bindings)?
4. Pager-fed subscriptions: drop stream-side cursors (client-held resume) per cloudflare-os?
5. Bless increments 1–6 as specced?
