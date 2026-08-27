---
status: in-progress
size: small
---

# failingTest: expected-fail pins with a concrete failure assertion

## Status summary

In progress. A `failingTest` helper replaces bare `test.fails` for pinned
platform bugs, then the quarantined facet source-version pin converts to it
— with a restructure that makes it immune to the coincidental-recycle false
alarm that got it quarantined (7+ red runs).

## The problem with `test.fails`

`test.fails` passes when the body fails for ANY reason and goes red when the
body succeeds. Two failure modes bit us:

- A body that starts failing for a DIFFERENT reason (infra error, typo)
  stays silently green — the pin no longer pins anything.
- A body that succeeds coincidentally (the facet pin's recycle-in-the-poll-
  window) goes red exactly like "bug fixed" — 7+ false alarms, each flipping
  an unrelated PR's CI.

## The helper (Misha's sketch)

```ts
failingTest({ failure: /SAME-BOOT STALENESS/ }, "facet picks up commits", async () => {
  // asserts the DESIRED behavior; today it throws the matched error
});
```

Semantics: body fails matching `failure` → test passes (bug still pinned).
Body fails with anything else → red ("expected failure to match X, got Y").
Body succeeds → red ("should have failed — if the bug is fixed, delete the
wrapper and keep the body as a plain test"). One care point from the sketch:
the success-path throw must live AFTER the try/catch, or the catch treats it
as a candidate failure.

## Checklist

- [ ] `failingTest(options, name, body)` in shared test-support, with the
  assertion core (`expectFailure`) exported separately so it can be unit
  tested without nesting vitest. Options: `{ failure: RegExp, timeout?: ms }`.
- [ ] Unit tests: matching failure passes; mismatching failure rejects
  naming both patterns; success rejects with the delete-the-wrapper message.
- [ ] Convert `userspace-facet-source-version.e2e.test.ts` from `test.skip`
  back to a live pin via `failingTest`, restructured for coincidence
  immunity: after each source commit, classify answers by BOOT — same-boot
  stale accumulates toward the concrete `SAME-BOOT STALENESS` error
  (matched by the wrapper), same-boot new-revision means fixed (body
  succeeds → wrapper alerts), a DIFFERENT boot means the facet recycled
  coincidentally → the round is inconclusive, so commit a fresh revision
  against the now-running facet and observe again (bounded rounds; all
  rounds interrupted → a distinct loud error). The unchanged-source
  stability coverage in the same test comes back for free.
- [ ] Update the quarantine note in `tasks/platform-stall-repros.md`
  (thread 5's exit happens via coincidence-immunity now; provenance remains
  a nice-to-have, no longer the gate).
- [ ] Short docs note in docs/testing.md next to the quarantine protocol:
  when to use failingTest vs test.fails vs skip.
- [ ] Verify the converted test against local dev: green (bug present,
  error matches), and the failure message is the concrete one.

## Implementation log

(appended as work happens)
