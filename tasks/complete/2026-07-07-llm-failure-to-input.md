---
status: done
size: small
---

# Turn failed LLM requests into agent input events (no more bricked streams)

## Status summary

Done, pending review. Failed LLM requests now become model-visible input
events with bounded auto-retry (2 retries, then wait for the user). All main
pieces landed with tests; nothing missing.

## Goal

From https://github.com/iterate/iterate/pull/1716#issuecomment (jonastemplestein):

> This is a good fix, but in addition a more general fix would be good. It
> should not be possible for an error of any kind to brick a stream. Just like
> pi agent, any errors should be turned into input events that can be included
> in subsequent requests

Today `AgentProcessor` has no handling for
`events.iterate.com/agent/llm-request-completed` with
`result.status: "failure"` — the reducer clears `currentRequest` and the
conversation dies silently. Script errors already have the right pattern
("Your script threw: ..." feeds back as a triggering input); LLM failures
should do the same.

- [x] Reduce: track `consecutiveLlmFailures` in agent state (increment on
      failed completion, reset on success). _Contract stateSchema + matched
      branch of the llm-request-completed reducer._
- [x] Side effect: on failed `llm-request-completed`, append an
      `agent/input-added` carrying the error message. _New processEvent case;
      stale completions (mismatched llmRequestId, e.g. post-cancel) are
      ignored, mirroring the reducer guard._ - Trigger policy `after-current-request` while
      `consecutiveLlmFailures < 3` → automatic retry with the error visible
      in context, so the model can react (fix a bad request, tell the user). - Policy `dont-trigger-request` from the 3rd consecutive failure → no
      infinite retry loop on persistent failures (bad API key, provider
      outage); the errors sit in context and the next user message resumes
      normally.
- [x] Tests in `agent-processors.test.ts`: failure → error input + retry
      scheduled; three consecutive failures → error input recorded but no new
      request; success resets the counter. _Driving lesson re-learned: every
      appended event needs its own delivery hop before its side effects run._
- [x] Stacked PR: base `mmkal/fix-stream-skill`, reply to + resolve Jonas's
      comment. _https://github.com/iterate/iterate/pull/1729_

## Assumptions

- Cap of 3 consecutive failures (2 automatic retries) — arbitrary but small;
  persistent failures burn provider calls otherwise. Trivial to tune.
- The error input is model-visible context, not a user-visible chat message.
  User visibility comes for free on the retry turn (the model can
  `sendMessage` an apology/explanation), which handles the transient case;
  for the persistently-failing case the UI already shows raw events. A
  direct user-facing "something broke" message would need the chat
  capability, which the agent processor deliberately doesn't hold.
- Cancelled requests (user interrupts) are NOT failures — no error input.

## Implementation log

- 2026-07-07: implemented reducer counter + processEvent error-input case.
  Test for the retry loop initially caught a stale duplicate
  llm-request-requested (the seeded request's debounce timer) — fixed by
  waiting on the retry generation's own requestId, and by seeding
  llm-provider-selected so retries stay on openai-ws instead of falling back
  to the default provider.
