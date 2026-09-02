---
status: ready
size: small
---

# Retire "lane" from the test vocabulary

"Lane" was agent-coined and spread through docs, env vars, and telemetry as the name for a CI test-execution category. The house term going forward is **suite**. The `terminology/no-metaphorical-lane-door-seam` linter rule already bans new uses; this task retires the existing ones, cheapest first, without a big-bang rename.

Already done (PR #2562): the flake dashboard's whole surface (event contract, processor state, issue render, reporter) uses `suite`; the one read of `TEST_TELEMETRY_LANE` carries a reasoned line-level lint directive pointing here.

- [ ] Docs prose: `docs/testing.md` ("test lanes" tables/headings), `docs/ci-test-telemetry.md`, other docs referencing lanes → "test suites". No code, no data — one mechanical PR.
- [ ] Internal identifiers in scripts/ci telemetry code (variables, comments) where no wire format is involved.
- [ ] Decide the wire tail ONCE: `TEST_TELEMETRY_LANE` (workflow env) and the PostHog `lane` event fields. Options: (a) freeze as wire format forever, boundary reads annotated with the lint directive (zero migration risk, historical joins intact); (b) dual-read `TEST_TELEMETRY_SUITE || TEST_TELEMETRY_LANE` + dual-write PostHog fields for a deprecation window, then drop. Leaning (a) unless there's appetite for the analytics churn — write the decision here and stop.
