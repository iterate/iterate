---
status: in-progress
size: small
---

# Turn failed LLM requests into agent input events (no more bricked streams)

## Status summary

Fleshed out from Jonas's review comment on PR #1716; implementation starting.
Stacked on `mmkal/fix-stream-skill` (the HEIC fix + repro harness).

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

- [ ] Reduce: track `consecutiveLlmFailures` in agent state (increment on
      failed completion, reset on success).
- [ ] Side effect: on failed `llm-request-completed`, append an
      `agent/input-added` carrying the error message.
      - Trigger policy `after-current-request` while
        `consecutiveLlmFailures < 3` → automatic retry with the error visible
        in context, so the model can react (fix a bad request, tell the user).
      - Policy `dont-trigger-request` from the 3rd consecutive failure → no
        infinite retry loop on persistent failures (bad API key, provider
        outage); the errors sit in context and the next user message resumes
        normally.
- [ ] Tests in `agent-processors.test.ts`: failure → error input + retry
      scheduled; three consecutive failures → error input recorded but no new
      request; success resets the counter.
- [ ] Stacked PR: base `mmkal/fix-stream-skill`, reply to + resolve Jonas's
      comment.

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

(started 2026-07-07, from PR #1716 review follow-up)
