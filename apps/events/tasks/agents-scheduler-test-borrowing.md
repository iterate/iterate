---
state: todo
priority: medium
size: medium
dependsOn:
  - subscription-scheduler-cleanup.md
---

# Borrow more from Cloudflare Agents scheduler tests

This is a follow-up task for the webhook subscription scheduler in
`apps/events/src/durable-objects/stream.ts`.

The goal is to more aggressively steal from Cloudflare Agents scheduling prior
art, especially their tests, comments, and possibly parts of their test harness.

## Why this exists

Our current scheduler shape is already close to the right Durable Object model:

- one Durable Object per stream
- one alarm slot per object
- reduced state owns `nextDeliveryAt`
- retries are event-sourced instead of sleeping in-process

What we have **not** mined deeply enough yet is the Agents SDK test suite around

- overlap prevention
- alarm initialization
- retry timing
- hung work
- scheduler recovery

Those tests are where a lot of the real design intent lives.

## First-party/source references to mine

- Durable Objects alarms:
  - https://developers.cloudflare.com/durable-objects/api/alarms/
- Agents schedule docs:
  - https://developers.cloudflare.com/agents/api-reference/schedule-tasks/
- Agents retries docs:
  - https://developers.cloudflare.com/agents/api-reference/retries/
- Agents scheduler implementation:
  - https://github.com/cloudflare/agents/blob/main/packages/agents/src/index.ts#L2854-L3128
- Agents retry helper:
  - https://github.com/cloudflare/agents/blob/main/packages/agents/src/retries.ts#L68-L139
- Agents alarm tests:
  - https://github.com/cloudflare/agents/blob/main/packages/agents/src/tests/alarms.test.ts#L26-L95
- Agents schedule tests:
  - https://github.com/cloudflare/agents/blob/main/packages/agents/src/tests/schedule.test.ts#L131-L360
- Agents retry integration tests:
  - https://github.com/cloudflare/agents/blob/main/packages/agents/src/tests/retry-integration.test.ts#L135-L185

## Main question

Should `apps/events` continue to be mostly network-e2e for scheduler behavior, or
should we also borrow some of the Agents-style lower-level scheduler harness so
we can cover nastier timing/overlap cases without making every test go through a
full worker + mock HTTP setup?

This task should answer that explicitly rather than drifting into a hybrid by
accident.

## Proposed work

### 1. Read the Agents tests like design docs

Pull out the behaviors that map directly to our stream subscription scheduler:

- one alarm derived from many logical scheduled items
- what is supposed to happen when work overlaps
- what is supposed to happen when work looks hung
- when raw alarm retries matter vs when app-level retry state matters
- what gets persisted durably to survive object eviction and restart

Capture those takeaways in comments near `alarm()` and the reducer fences in
`stream.ts`, with first-party links where the comment is justified by docs or
source.

### 2. Steal the best test scenarios

Add the highest-signal missing cases to `apps/events/e2e/vitest/`:

- a response body that never finishes does not wedge unrelated subscribers forever
- a slow subscriber does not make another subscriber's retry happen late
- retries still happen when there is no incidental worker traffic between attempts
- raw history/SSE still expose internal `subscription.*` events while webhook delivery never does
- repeated backlog drains in order across more than one queued user event

These should stay readable and black-box.

### 3. Decide whether to borrow a lighter-weight harness

Investigate whether a small local harness inspired by the Agents tests would
make sense for `apps/events`, for example:

- driving `alarm()` deterministically
- controlling time more tightly
- testing overlap/hung-work semantics without a full end-to-end worker spin-up

If we do this, keep the bar high:

- no giant custom framework
- no re-export soup
- no duplication of the product scheduler
- clear explanation of why the harness is worth its maintenance cost

If it is **not** worth it, record that decision in this task and keep pushing
coverage through the network e2e layer instead.

## Acceptance criteria

- there is a short written conclusion on whether an Agents-style scheduler test harness is worth adopting here
- the best missing Agents-inspired scheduler scenarios are either implemented as e2e tests or explicitly deferred with reasons
- `stream.ts` comments link to first-party docs/source where those fences come from
- we have a clearer explanation of where our scheduler intentionally diverges from Agents

## Notes

One deliberate divergence already seems likely to stay:

- Agents processes due schedules sequentially
- we currently process due subscribers in parallel because unrelated webhook
  subscribers should not head-of-line block each other

If we keep that divergence, it should be documented right next to `alarm()` with
links to the Agents source/tests that motivated the comparison.
