# Fix log — the campaign (companion to DEFECTS.md + ACTION-PLAN.md)

One line per landed change; newest last. Larger layering/design refactors go to
REFACTORS-LATER.md instead, not here.

- Phase 0 (bc6aee3cf, live-16): 10 no-brainer guards — charset gate (38/U1/39), reserved-prefix
  fence (34), provide round-trip (5/40), **proto** defineProperty (4), payload-less defaults
  (8/44), CapabilityProvision Symbol.dispose (23), config path validation (41).
- Test cook-down: three vitest configs → ONE (vitest.config.ts, `test.projects`: unit/harness/
  workers); `pnpm test` runs all three; `pnpm test:unit` is the fast inner loop. Deleted
  vitest.harness.config.ts + vitest.workers.config.ts + their scripts.
- Phase A (live-17): half-enabled-provide door killed. #facet() configures at materialization
  from the mount alone (identity derived entirely from the mount + DO address), idempotent;
  #facet throws NO_FACET for unknown slugs (no silent resurrection); enableProcessor validates
  the slug + built-in registry and drops its separate configure. Retires 29, 30, 32, 42, 45,
  H6. Both facet kinds' configure is idempotent (JSON-equal short-circuit + memo drop). 6 tests
  flipped to regression guards.
- Phase B (live-18): delivery correctness. ONE consumesEvent(consumes, event) exported from
  processor.ts — the reduce, both delivery lanes, and the inline core all call it; 2 divergent
  filter copies DELETED (the consumes ['*'] black hole, 10+11). read() short-page proof is the
  HEAD, never a beyond-head afterOffset (9); resumeSubscription clamps afterOffset to head (13);
  forwarder CAS treats a deleted progress record as ABANDON, no ghost halt (12). 5 tests flipped.
