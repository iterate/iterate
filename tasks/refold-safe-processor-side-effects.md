---
state: done
priority: medium
size: small
tags: [os, streams, processors, recovery]
---

# Gate per-event vendor side effects for refold safety (slack-agent, slack router, repo)

Found 2026-07-09 by PR #1801's adversarial review (round 2). That PR made
"state-schema change ⇒ discard checkpoint ⇒ full journal refold" the NORMAL
deploy path for a processor whose stored snapshot no longer parses
(`StreamProcessor.#loadState` treats it as a cache miss). Reconcilers and
render-appends are refold-safe (at-head gate + idempotency keys), but three
processors still did per-event vendor work in `processEvent` guarded only by
event-time state, which a refold re-executes for the whole journal:

1. **slack-agent**: `assistant.threads.setStatus` and `reactions.add`/`remove`
   re-fired for every historical message — a rate-limit crash-loop inside
   `blockProcessorWhile`, plus 👀 reactions resurrected on old messages.
2. **slack router**: `acknowledgeRoutedWebhook` re-acked every historical
   webhook.
3. **repo processor**: `createRepoArtifact` re-ran because the
   `state.created` guard sees event-time state — and its seeding force-pushes
   the seed commit, clobbering user commits.

## Resolution (done 2026-07-09)

- **slack-agent**: the 👀 ack is freshness-gated (`webhookAckIsFresh`,
  15-minute horizon); the assistant status became a once-per-batch repaint of
  the latest lifecycle fact, gated on at-head + freshness (this also un-raced
  the per-event `blockProcessorWhile` closures, which run concurrently within
  a batch).
- **slack router**: the fast ack is freshness-gated; the durable forwards
  keep replaying and dedupe via idempotency keys, as designed.
- **repo**: creation is now an obligation reconciled from the at-head fold
  (`createRequested` folded into state, `createRequested && !created` checked
  in `processEventBatch`) — the schema change this required ships together
  with the refold-safe code that performs the resulting refold.
- Doctrine + the required **refold test** documented in
  [writing-stream-processors.md](../docs/writing-stream-processors.md)
  ("Refold safety"); refold tests added for all three processors
  (`slack-processors.test.ts`, `pr-agent.test.ts`).
- The remaining processor fleet was audited: every other vendor-touching lane
  is idempotency-keyed, at-head-reconciled, or soft-fail
  (project processor's worker probe re-runs on refold but is a bounded
  read-only readiness wait).
