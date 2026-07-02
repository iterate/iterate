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

LLM request processors guard agent-visible appends with a still-current check
(`#isRequestStillCurrent` in
`apps/os/src/domains/agents/cloudflare-ai-processor-implementation.ts` and
`apps/os/src/domains/agents/openai-ws-processor-implementation.ts`): they
re-read committed history and only append `agent/output-added` if the agent is
still waiting on this request. That is check-then-act — if an
`agent/llm-request-cancelled` commits between the check and the append, the
output reaches the stream but the agent reducer's guard ignores it, so the
model never sees its own response in history.

The window is small and the failure is benign-ish (a cancelled turn's output
is dropped — arguably what cancellation means), which is why this is backlog.

## Direction

An append precondition evaluated inside the Stream DO's commit path, e.g.
`append({ event, ifCurrentRequestIs: llmRequestId })` or a generic
`ifStateMatches`/`expectedOffset` CAS. The still-current re-read then stops
being advisory: the stream itself refuses stale appends atomically.

Cares:

- Keep it generic (offset CAS or a reducer-predicate hook), not an
  agent-specific flag on the stream API.
- The providers' stale path must still append their provider-level
  `llm-request-completed` (observability) — only agent-visible events are
  conditional.
