---
status: in-progress
size: small
---

# The wake rule's append count depends on the ladder's jitter

Status: explained, repro being pinned. No fix yet: Misha wants the explanation first, then a
decision on product vs. test.

## Why

`apps/os/src/stream/subscription-delivery.test.ts`, row "fan-out, the wake rule: a wake handler
appending work that fails climbs one hop a lap, stops at 8, goes quiet", asserts
`expect(depths.length).toBeLessThan(20)`. About 1–2% of runs append 20 or more `test/work` events
and fail (CI "Test / test" on PR #3488, Depot run 7v0w6p36fz, job 4vj94xb8p3; the retry passed).

The durable retry ladder is jittered ±20% (`packages/iterate/src/platform-retry.ts`
`durableLadderDelayMs`, `Math.random()`), so the order in which pending records come due differs
run to run, and with it how many times the climb restarts.

## What happens (seed 185, 20 appends: `[1..8, 2..8, 4..8]`)

- **Climb 1 (depths 1→8).** Each alarm wake is caused by the deepest record due at that instant
  (`owedCause`); the handler appends one hop deeper. After 3 distinct failures the row pauses and
  only admits a new event at its probe's rung, so the rest of the climb is probe-paced. A wake at
  depth 8 makes the handler's append refused (depth 9): one `itx/loop-limit` fact.
- **Climb 2 (restart at 2, ~58 min).** The sink row consumes every durable event, so the next
  probe admits the `itx/loop-limit` fact itself. The sink acks it, and an ack is "the first
  success": the pause lifts and the probe count resets (`#fanOutDelivered`). The next alarm wake
  is caused by whichever record's rung comes first, often a shallow one (here depth 1), and the
  unpaused row admits it. A new climb starts from there.
- **Climb 3 (restart at 4, ~3 h 10 min).** Records dead-letter after 15 attempts. When the last
  one goes, "nothing at all is owed", so the paused row admits one new event: this incarnation's
  wake, caused by that last record. Jitter decides which record outlives the others, so a shallow
  one (here depth 3) can be last.

Every seed keeps the loop guard's guarantees: every append at depth ≤ 8, exactly one
`itx/loop-limit` fact, and the chain goes quiet. The count of appends is not something the design
bounds at 20: it is `8 + (8 − restart depth)` per restart.

## Plan

Assumption (Misha asked for a pinned-failing repro before any fix): the repro pins the row as it
stands, with a seeded ladder, as `test.fail`. Whether the resolution is a product change or a
test change is Misha's call, so this PR changes neither.

- [ ] make the ladder's jitter injectable: `SubscriptionDelivery` takes the random source the DO
      passes as `Math.random`, so a test replays one ordering without stubbing `Math.random`
- [ ] pinned `test.fail`: the same row, a seeded ladder that restarts the climb twice
- [ ] survey many seeds: the distribution of the append count, and which restart path each run
      takes
- [ ] decide (Misha): is the `itx/loop-limit` ack lifting the pause a defect (a product fix, like
      the wake's ack, which already lifts nothing), or is the bound wrong (drop it, or derive it)?
- [ ] resolve the flaky row on main along with that decision

## Implementation log
