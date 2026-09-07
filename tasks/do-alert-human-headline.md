---
status: ready
size: small
---

# DO cost headline: "We're spending $X/day on durable objects"

## Status summary

Spec'd 2026-09-07. Misha gave the headline verbatim; mockup with that
morning's real numbers DM'd to him. Not started.

## Why

The daily #error-pulse headline (#2590) is a row of DO-hours per account.
Nobody thinks in DO-hours.

## What changes

- [ ] The headline is exactly this sentence, nothing else:
      `We're spending $1,023/day on durable objects based on current usage
      ($161 dev/preview, $862 prd)`. Current usage = the last complete
      UTC hour's DO-hours × 24 × $0.005625, per account, summed. The last
      complete hour, because the probe runs at :41 with ~15–20 min of
      analytics lag, so the current hour is always partial.
- [ ] The rest is a table in the thread, opened on purpose: per account the
      latest hour, today so far, hours over the ceiling, pinned invocations;
      then the incident-docs and workflow-run links. The thread's first
      reply, created on the day's first run and rewritten every run after
      (`chat.update`; found among the bot's replies by its code-block
      table). Alert replies (over the ceiling in the last two hours, probe
      could not run) stay as they are, after it.
- [ ] `findOrCreateHeadline` matches the day's headline by the bot's
      messages since 00:00 UTC starting `We're spending` (test runs keep
      the `🧪 TEST RUN — ` prefix and their own thread).
- [ ] Probe failure: that account's number cannot be computed, so the
      sentence says so in its slot: `($161 dev/preview, prd: probe failed)`
      and the total is the accounts that answered.
- [ ] Unit tests updated for the sentence and the table.

## Out of scope

- Changing the ceilings or what counts as a breach.
- Fixing whatever is burning prd right now (2026-09-07: 6,385 DO-hours in one
  hour). See stream-do-wake-loop-runaway.md.
