> **HISTORY (2026-09-03).** The defect-fix campaign of 2026-08; closed 2026-08-28. Its "PHASE 0
> (DOING NOW)" is done, and the verbs it plans against (`provideCapability({ path, type })`,
> mounts, connections, the pathProxy) are all deleted. The surface as built is
> `docs/itx-surface-as-built.md`; the defects themselves are `DEFECTS.md`.

# Action plan — fixing the 45 defects while clarifying the code

Companion to DEFECTS.md. Principle (owner): NO invented machinery. Every fix is either (a) a
guard/validation at an existing door, (b) a one-line correction, or (c) a SEAM MOVE that deletes
a divergent copy or a side-channel. Clarification (fully-qualified names, DO composition) rides
ALONG with the fix that touches each file — never a separate churn pass.

## The three root-cause clusters (fix the root, retire many)

- **CLUSTER 1 — "success returned, durable outcome unverified"** (defects 5, 30, 34, 40, H6):
  a verb returns ok/offset while a later reduce/parse/configure silently drops the work. ROOT
  MOVE: every provide-family door round-trips its own event (parse(print(x))) BEFORE append and
  throws VALIDATION on mismatch; enablement configures at MATERIALIZATION (kill the
  configure-after-provide side-channel). Retires 5, 30, 40, 29, 32, 45 and half of 34.
- **CLUSTER 2 — "unvalidated identifier charset"** (defects 38, 39, 42, U1, secrets vector):
  a `:` (or worse) in a projectId / path segment / slug / secret name collapses a namespace
  wall or a cacheKey. ROOT MOVE: one charset gate at DurableObjectNameCodec.parse (projectId +
  path segments) + the secret-name and slug validators reuse it. Retires 38, 39, 42, U1.
- **CLUSTER 3 — "reserved namespace unenforced"** (defect 34): platform idempotencyKeys live in
  a namespace public appends can squat. ROOT MOVE: reject public idempotencyKeys under reserved
  prefixes at the append door (the apps/os iterate-internal fence).

## Phasing (each phase: fix + its clarification, board green, one commit)

- **PHASE 0 — the no-brainers (DOING NOW)**: the ☠ + trivial-⚠ guards that can only reject
  previously-broken input or add a missing method — zero regression surface. Charset gate (38,
  39, 42), reserved-prefix fence (34), provide round-trips (5, 40), **proto** guard (4),
  payload-less destructures (8, 44), CapabilityProvision Symbol.dispose (23), config array-path
  validation (41), caughtUp atHead (35). Each flips its test.fails → plain test.
- **PHASE 1 — the half-enabled door (30 cluster)**: configure-at-materialization inside
  #facet(); delete enableProcessor's configure leg; #facet throws NO_FACET for unknown slugs.
  Retires 29/30/32/45/H6. CLARIFY while here: the enablement path reads as ONE event-sourced
  concept (the mount IS the registry, no kv side-channel).
- **PHASE 2 — delivery correctness (10/11, 12, 13, 9, 43)**: extract ONE `consumesEvent(consumes,
event)` into core/events.ts, use in both lanes + the processor (deletes 2 divergent copies);
  revoked-row CAS treats missing progress as abandon; read() clamps beyond-head; kv.list
  paginates. CLARIFY: the shared filter names the consumes rule once.
- **PHASE 3 — the runner (6, 17, 18, 19, 20, 21, 22, 36)**: the highest-care family (owner:
  "fix with care + soak"). Commit-point dedupe skip (6), refold-cache guard (17), refold-ceiling
  (18), nested-blocker loop (19), at-head on page multiples (20), gap-repair-then-batch (21),
  jsonEqual depth (22), fast-fail throwing pull (36). Each with a targeted proof + a board soak.
- **PHASE 4 — connections (14, 15, 16, 31)**: relay close codes (1011 dirty / 1000 clean),
  pending-attach same-key reconcile, in-flight offline coding, unsubscribe closes the anonymous
  transport (mirror of onFinalClose).
- **PHASE 5 — parity features (24 dotted surface, 25 row chunking)**: the two owner-commissioned
  builds. 25 is well-specified (apps/os EVENT_CHUNK_SIZE contract → StreamEventLog gains an
  event_chunks table, offset-per-event). 24 needs the reserved-name decision on Itx first.
- **DEFER**: 7 (breaker placement — a real decision), the defect-28 harness/loader lane and the
  quiesce-choreography TODOs (need a pool-lane clock rig), the WS-upgrade-adapter (27b).

## Clarification riders (no separate churn pass)

- StreamEventLog gains the charset gate + reserved-prefix fence (phase 0) — its header already
  owns "the commit point"; these are commit-point invariants.
- The consumes filter extraction (phase 2) is the last divergent-logic copy after the wave-1
  sweep — names the rule in one place (core/events.ts) beside DeliveryPolicy.
- Phase 1 lets #facetEntries + #facet read as one event-sourced story; drop the "registry"
  language entirely.
