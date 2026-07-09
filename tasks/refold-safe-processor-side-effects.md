---
state: todo
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
processors still do per-event vendor work in `processEvent` guarded only by
event-time state, which a refold re-executes for the whole journal:

1. **slack-agent** (`slack-agent-processor-implementation.ts` ~205-230):
   `assistant.threads.setStatus` and `reactions.add`/`remove` re-fire for
   every historical message. `#callSlackApi` tolerates `already_reacted` /
   `no_reaction` but rethrows `rate_limited` inside `blockProcessorWhile` —
   a refold burst becomes a rate-limit crash-loop, plus 👀 reactions
   resurrected on old messages.
2. **slack router** (`slack-processor-implementation.ts` ~90-92):
   `acknowledgeRoutedWebhook` re-acks every historical webhook.
3. **repo processor** (`repo-processor-implementation.ts` ~132-135):
   `createRepoArtifact` re-runs because the `state.created` guard sees
   event-time state (the `repo/created` event folds later in the replay) — a
   real artifact-creation call against an already-created repo.

Fix shape (per docs/writing-stream-processors.md): cosmetic/at-head-only
lanes (Slack status/reactions, webhook acks) should gate on
`checkpointOffset >= streamMaxOffset` exactly like the reconcilers — they are
only meaningful at head; `createRepoArtifact` needs an idempotency check of
its own (create-if-absent at the Artifacts API).

Must land before the first state-schema change ships to any of these three
contracts; until then the hazard is latent (their schemas were untouched by
PR #1801).
