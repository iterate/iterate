# Fix log — the campaign (companion to DEFECTS.md + ACTION-PLAN.md)

One line per landed change; newest last. Larger layering/design refactors go to
REFACTORS-LATER.md instead, not here.

- Phase 0 (bc6aee3cf, live-16): 10 no-brainer guards — charset gate (38/U1/39), reserved-prefix
  fence (34), provide round-trip (5/40), **proto** defineProperty (4), payload-less defaults
  (8/44), CapabilityProvision Symbol.dispose (23), config path validation (41).
- Test cook-down: three vitest configs → ONE (vitest.config.ts, `test.projects`: unit/harness/
  workers); `pnpm test` runs all three; `pnpm test:unit` is the fast inner loop. Deleted
  vitest.harness.config.ts + vitest.workers.config.ts + their scripts.
