---
status: in-progress
size: small
---

# Typed agent append

## Status

Implementation has not started. The intended surface and verification are specified below; the main open work is the contract-derived input type, public RPC method, generated artifacts, and tests.

## Goal

Expose `itx.agents.get(path).append(...)` as the direct event-oriented alternative to one-helper-per-agent-event APIs. Its input must be a discriminated union derived from `AgentProcessorContract.consumes`, so changing the processor contract or an owned payload schema automatically changes the public itx type.

## Assumptions

- This first slice follows the proposed API literally: the type is derived from every event the agent processor consumes, including dependency-owned lifecycle events.
- `append` forwards to the agent's existing stream and returns the committed events in input order.
- Existing helpers such as `message`, `setStatus`, and `addFiles` remain; replacing or removing them is outside this change.
- Runtime authorization is unchanged. Callers can already append arbitrary inputs through `itx.streams.get(agentPath).append(...)`; this change adds a discoverable, statically narrowed door on the agent handle.
- The existing generator should expand a named contract-derived alias without structural-deduplication changes. If generation demonstrates otherwise, record and address the smallest generator gap.

## Checklist

- [ ] Add a public contract utility for append-inputs corresponding to a processor's `consumes` list.
- [ ] Add an agent-specific append-input type derived from `AgentProcessorContract`.
- [ ] Expose `Agent.append(...events)` and forward inputs to the agent stream.
- [ ] Prove valid consumed events compile and invalid event types/payloads fail through the generated public API.
- [ ] Regenerate the flat itx API, type graph, and published `iterate/sdk` copy.
- [ ] Run focused tests, typecheck, lint, and formatting checks.

## Implementation log

- 2026-07-17: Task specified on a fresh worktree from `origin/main`. No implementation decisions beyond the assumptions above have been committed yet.
