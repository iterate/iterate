# Live state — the three-kinds answer (converged design, judged from two independent attempts)

## SHIPPED VERDICT (2026-08-18, owner's calls — supersedes the fork below)

Two owner rejections got this to its final shape. First build (increment 48): nudge + re-pull
flush engine — rejected ("the ephemeral events carry the delta patch… elixir liveview style").
Second build: patches on the wire but with the STREAM tracking each row's revision chain and
re-seeding through a row-held `get` door — simplified away mid-review ("why not just say in
each ephemeral event 'i am the diff relative to offset x'; each client reads the snapshot to
get offset and state, then consumes patches going forward"). A 31-agent adversarial review of
the intermediate confirmed its only two real protocol bugs (late-abandoned frame breaking the
promised order; un-raced seed invoke wedging a row) — both in exactly the machinery the final
design deletes. What shipped (increment 49, live-6):

- `events.iterate.com/live-state/changed` payload = `{key, from, to, patch}`: an RFC 6902
  subset (add/replace/remove, `core/patch.ts`, ~110 dependency-free lines diff+apply, both
  sides JSON-normalized, own-property traversal, `__proto__` refused). Arrays: pure append →
  `add …/-`, tail truncate → removes, wholesale replace otherwise — the LiveView trade.
- Revisions are PRODUCER-OWNED: a processor chains an in-memory `#liveStateRev` seeded from its
  fold cursor (minted at first `liveSnapshot()`, advanced per emission — so `from`/`to` ARE
  fold offsets and silent batches can't break the chain); the mini-app helper chains a local
  counter. Persist-first-emit-second; the rev advances even on append failure (a hole in the
  chain is a re-seed, a lie in it is corruption).
- The stream is a PURE FORWARDER (~15 lines): each committed change payload is pushed
  fire-and-forget at every row watching the key. `liveState: {key}` is the ENTIRE delivery
  policy — no `get`, no cursor, no ladder, no mount seed, no per-row server state, no ordering
  promise, nothing to resurrect.
- THE CLIENT owns the chain (~20 lines, proven in prove_livestate.mjs): subscribe (buffer),
  read the producer's door — `liveSnapshot()` / a helper-backed accessor, both answering
  `{rev, state}` atomically — then per payload: `to ≤ rev` → drop (duplicate), `from === rev` →
  applyPatch + advance, else → re-read the door. Reorder, drop, any eviction, producer rebirth:
  all the SAME client-side case. This is LiveView's own shape (desync → full re-render), moved
  to where the state actually lives.
- Loop guard unchanged and load-bearing: the type is unconsumable before contracts are
  consulted, so patch-carrying events can never feed a fold.

Accepted residue: a crash between a processor's persist and its emit loses one notification —
clients heal on the NEXT change, so a key that never changes again can stay stale (documented);
mini-app state is as durable as its holder (a reborn holder restarts at rev 0/initial — clients
past rev 0 see the chain break and re-read, making the loss visible rather than papered over).

## Are the three kinds the same thing? Yes at three layers, no at one — and the "no" is load-bearing.

SAME: (a) the ROW — all three are a capability-provided event (shadowable, revocable,
event-sourced, identity = providedAtOffset, policy in the payload); (b) the TRANSPORT — a stub
parked at the relay behind a pager, DO holds sockets only, wake→borrowed leg per burst;
(c) the LIFECYCLE — provide/revoke/shadow, delivery by row identity, /state visibility.

DIFFERENT: the ENGINE per kind, because each engine IS the recovery semantics of its noun:

- events → cursor + retry ladder (history must be COMPLETE);
- live state → latest-wins flush + a SEED door (the present is RE-ASKABLE — never replay);
- provided capability → no engine (callers retry; the resolver pulls calls in).
  Both designers independently wrote the same warning: forcing one engine would corrupt
  semantics (retrying a stale frame is wrong; skipping a durable event is wrong).

## The converged mechanism

- Live state = a THIRD delivery policy on the existing subscription mount:
  `delivery: { liveState: { key/source, get } }`. No new noun, no new transport, NO new
  durable state — state rows have no cursor at all; the mount event is the restore-param
  (Kenton-aligned).
- The change signal = an EPHEMERAL event on the stream ("writes are the notification" — the
  cloudflare-os lesson). Revision = the shared stream OFFSET: monotonic, ordered across keys,
  survives publisher restarts (apps/os's streamGeneration epoch is subsumed and deleted).
- Recovery is always RE-SEED: on subscribe, on incarnation resurrection, on client gap →
  evaluate the row's `get` expression (any itx expression answering current state). Dropped
  frames are harmless by construction. No keepalive; sockets-ephemeral doctrine holds.
- Wire protocol ported VERBATIM from apps/os (`LiveUpdate = snapshot | patch`, diff.ts's
  reference-first structural diff, store.ts's revision discipline + resync-on-gap) — ~350-550
  proven lines; v1 may ship snapshots-only with patches reserved (no wire break).
- What is NOT built (the unification payoff): apps/os's live-state-pager (~430 lines) + relay
  lane RpcTargets (~300) — the second socket-lane machinery collapses into our existing
  park/wake transport, which increments 35-45 already built.

## THE ONE FORK (owner's call)

A) PARENT-STAGED PUSH (designer A): the ephemeral frame CARRIES the state; the parent stages
latest-wins per row inline at the commit point (beside the subscription projection), 50ms
debounce, flushes via deliverSubscription. Simple; but full state rides every mutation
through the pump (marshalling cost per enabled facet), snapshots-only v1. ~225 authored.
B) FACET-LANE PULL-DIFF (designer B): the ephemeral frame is a NUDGE only; the ictx facet
holds in-memory lanes that PULL the source projection (single-flight, monotonic), diff
against ONE shared baseline, and flush PATCHES to N subscribers from one diff. Cheaper per
mutation and per subscriber; the full apps/os engine ports (~800 proven lines incl. tests);
lanes die with facet aborts (healed by re-seed; debounce loss bounded by the alarms).
~220 original.
Recommendation: B's pull-diff for the engine (one diff serves N; patches; bounded projections
via getLiveState), with A's parent-side scheduling (the parent has alarms and sees every body
at the commit point) — i.e. parent schedules, facet lane diffs.

## SDK (identical in both designs, near enough)

Processor: one OPTIONAL method — `liveState(state) { return {...projection...} }` — published
after every committed fold. Mini-app chatroom (NOT a processor): a ~15-line SDK helper making
write and notification inseparable:
this.chat = liveState(env.ITX, "chat", { messages: [] });
this.chat.set({ messages: [...] }); // mutation IS the notification (ephemeral append)
state() { return this.chat.get(); } // THE SEED DOOR
Client: `itx.subscribe({ name, liveState: { key, get }, target: (update) => store.apply(u) })`
— the live callback parks via the existing kind-3 machinery; the React hook stack ports later.

## Open questions (plain language)

1. The fork: A (parent-staged push), B (facet-lane pull-diff), or the recommended hybrid?
2. Patches now (port diff.ts + engine v1) or snapshots-first with patches reserved?
3. Failed state pushes: drop-and-revoke-with-audit (state is re-derivable) or a small bounded
   retry before revoke?
4. Should processors' liveState frames be observable by OTHER processors (naming the type in
   consumes)? Harmless for views; one loud doc line either way.

## Increment plan

1. Policy union + deliverTo raw-args generalization + parent scheduling (+seed paths).
2. Port protocol/diff/store; the flush engine (per the fork decision); SDK liveState() both
   flavors; live proof: chatroom mini-app + processor fold, subscribe/mutate/reconnect/reseed.
3. Browser hook stack when a real browser client exists.
