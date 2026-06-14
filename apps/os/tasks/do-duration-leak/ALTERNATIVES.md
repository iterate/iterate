# Fix alternatives — detailed menu

Detailed write-up of every option we considered, so we can revisit a rejected one
later. Chosen approach: **Option 1 (Idle teardown, Stream-DO-authoritative)**. See
DECISION_LOG.md for why.

Root cause recap: each subscription retains two cross-isolate RPC stubs over one
session — Stream DO holds the `processEventBatch` callback (pins the subscriber);
subscriber holds the stream handle (`entry.stream`, pins the Stream DO). An open
session bills duration on both ends (no RPC hibernation; only WebSockets get it).
No idle teardown exists today (`implementation.ts:615–652`).

---

## Option 1 — Idle teardown + re-dial on append ✅ CHOSEN

Stream DO is the authority. Track last-activity; a DO alarm fires after an idle
window; on fire (if still idle) the Stream DO **deletes all live connections** —
disposes every callback stub (frees subscribers) AND calls each subscriber to
release its retained stream handle (frees the Stream DO) — then hibernates. The
durable `subscriptionsByKey` config persists; on the next append/wake the existing
`woken → reconcileConnections → dial` path re-dials every subscriber, which
re-handshakes from its durable checkpoint (replay covers the gap).

- Touches: `stream.ts` (alarm schedule + `alarm()` handler; suppress the
  constructor `woken` re-dial on the idle-alarm wake), `implementation.ts`
  (`Connection` close-all + per-connection subscriber-release; new disconnect
  reason `"idle"`), `core/contract.ts` (reason enum), a new
  `releaseStreamSubscription` RPC on the subscriber host (`stream-processor-host.ts`).
- Pros: stops idle billing on BOTH ends; reuses 100% of reconcile + generation
  gate + checkpoint replay; no public subscription-contract change; latency
  unaffected when active (alarm pushed forward on every append).
- Cons: one alarm storage write per idle window; must suppress the constructor's
  woken-reconcile on the alarm wake or it thrashes (re-dial→teardown loop); idle
  window needs tuning.
- Risk: MEDIUM. Race: append lands while alarm firing — guard with "re-check
  idle at alarm fire; any wake cancels/reschedules the alarm".

## Option 2 — Subscriber-driven pull via alarm ❌ rejected (for now)

Invert to pull: subscriber wakes on its own alarm, pulls events since checkpoint,
no retained callback on the Stream DO.

- Pros: zero retained stubs; both DOs fully hibernate.
- Cons: **breaks real-time push** — events wait up to the pull interval; exactly-once
  becomes fragile (ingest/checkpoint must be atomic or idempotent); more RPC
  traffic. Risk HIGH. Rejected: gives up the push latency guarantee the product
  relies on.

## Option 3 — Hibernatable WebSocket transport ❌ rejected (heavy)

Move cross-DO delivery onto the WebSocket Hibernation API (doesn't bill idle).

- Pros: true hibernation; durable buffer preserves delivery.
- Cons: whole new transport layer + handshake; subscriber must expose a WS upgrade
  endpoint; slight wake latency; incompatible with the existing callable-subscriber
  infra without a rewrite. Risk MEDIUM-HIGH. Rejected: largest surface for the same
  outcome Option 1 achieves with reconcile we already have. Revisit if we want
  idle billing → 0 with no alarm churn at very high subscription counts.

## Option 4 — Lease/heartbeat with expiry ❌ rejected (close 2nd)

Subscriptions carry a TTL; subscriber renews on activity; Stream DO drops
connections whose lease lapses.

- Pros: surgical; compatible with reconcile + generation gate.
- Cons: renewal RPC per ingest; clock-skew grace windows; expiry not atomic with
  close. Risk MEDIUM. Rejected vs Option 1 because it adds steady-state renewal
  traffic for always-on agents and still needs a sweep alarm — Option 1's
  "push the alarm forward on activity" gets the same result without per-batch
  renewals. **Best fallback if alarm-storage churn proves costly.**

## Option 5 — Reference-count / dispose discipline ❌ rejected (breaking)

Retain only a per-subscription factory; create+dispose a fresh per-batch callback
each delivery.

- Cons: changes the public subscription callable contract (callback → factory) —
  breaking for all processors/agents; per-batch factory RPC overhead. Risk HIGH.
  Rejected: breaking change for a problem the idle case already solves.

## Option 6 — Co-location / topology (partial revert of #1500) ❌ rejected (defeats split)

Keep a Stream DO and its hot subscribers in one script so the session is
in-isolate (free) again.

- Pros: zero billing for co-located hot subscribers; reuses all machinery.
- Cons: only helps co-located subscribers (remote agents still leak); reintroduces
  shared-isolate coupling the split deliberately removed; new callable type. Risk
  LOW-MEDIUM. Rejected: narrows the blast radius but doesn't fix remote subscribers
  and undoes the split's isolation. Keep in pocket as a perf optimization for the
  hottest same-app streams.

---

## Defense-in-depth candidates (separate from the fix; see task #6)

- CF budget alert on DO activeTime per script (catches recurrence in $).
- An invariant/assert + test: "no Stream DO holds a live outbound connection after
  N minutes of no appends" — runs in the workerd suite and as a periodic prod probe.
- A periodic GraphQL probe (scheduled agent) that flags any script whose
  wallTimeP99 exceeds e.g. 1h — the signature of a pinned DO.
- Lint/review guard against retaining a cross-script stub without a registered
  teardown path.
