---
state: backlog
priority: low
size: medium
dependsOn: []
---

# Streams: conditional appends (close the LLM-output cancellation race)

The one bug from the agents-system audit (June 2026) that survived the
reconciler/request-by-reference work (PRs #1460, #1483).

## Problem

The agent processor guards agent-visible appends with a still-current check
(`#isRequestStillCurrent` in
`apps/os/src/domains/agents/agent-processor-implementation.ts`): it re-reads
committed history and only appends assistant-role `agents/context-added` if
the agent is still waiting on this request. That is check-then-act — if an
`agent/llm-request-cancelled` commits between the check and the append, the
assistant context reaches the stream after cancellation. The reducer then
folds that stale response into model-visible history; only the script-execution
gate rejects it because the linked request is no longer live.

The window is small, but a later turn can now see output the user explicitly
cancelled, which is why the append still needs a commit-time precondition.

## Direction

An append precondition evaluated inside the Stream DO's commit path, e.g.
`append({ event, ifCurrentRequestIs: llmRequestId })` or a generic
`ifStateMatches`/`expectedOffset` CAS. The still-current re-read then stops
being advisory: the stream itself refuses stale appends atomically.

Cares:

- Keep it generic (offset CAS or a reducer-predicate hook), not an
  agent-specific flag on the stream API.
- The stale path must still append `agent/llm-request-completed`
  (observability) — only agent-visible assistant context is
  conditional.
