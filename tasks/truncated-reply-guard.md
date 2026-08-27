---
status: ready
size: small
---

# Truncated model replies are never executable

A completion cut off by max-tokens or a broken stream can end mid-`<codemode>`
block or mid-fence; both interpreters (the platform's AgentCodemode and
codemode-tag's vendored parser) will happily extract and run whatever
half-script survived.

This was fully implemented and spec'd on the prompt-sections branch, then
deliberately reverted before merge to keep PR #2512's diff to the prompt
model itself. **Start by reapplying commit `a9e3c7ef3`** (`git cherry-pick`
onto main after #2512 merges; expect light conflicts in the two test files
and regenerate itx-api). Its commit message is the design record. Summary:

- [ ] SSE drain in workers-ai-transport captures `choices[0].finish_reason`
      (last non-null wins — it rides the empty-delta final frame); non-streamed
      path reads it off the response object; journaled in rawResponse evidence
- [ ] `AgentLlmTransport` callLlm seam gains optional `finishReason` so
      harness transports can simulate truncation; absent = assume complete
      (dialects that never report one fail open, not block every reply)
- [ ] assistant `agents/context-added` payload gains optional
      `truncated: boolean` (on the EVENT: userland workers see only events,
      and replays must see the fact)
- [ ] both interpreters guard before parsing: corrective developer feedback
      ("your reply was truncated — NOTHING was executed; re-send"),
      after-current-request, idempotency key
      `agent/truncated-reply-rejected@<offset>` mirrored in both so the birth
      race dedupes (same pattern as malformed-snippet feedback)
- [ ] specs: transport finish_reason ("stop" on the existing gpt-5.5 fixture,
      "length" with rawResponse evidence), full harness loop (truncated reply
      → no script-run-requested → feedback → retry executes), and the
      parsing-off path (marker event-visible, platform interprets nothing)

Resolved question, for the record: AI Gateway BYOK proxies chunk bodies
verbatim and the response cache replays recorded SSE byte-identically;
finish_reason lives in chunk JSON, not headers — nothing strips it.
