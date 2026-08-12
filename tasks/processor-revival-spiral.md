---
status: in-progress
size: large
branch: processor-revival-spiral
---

# Processor host revival death spiral: repro + fix

## Status summary

Just started. Spec written from prod evidence gathered 2026-08-11 (~20:45–21:20 UTC, project "restaurant"). No repro tests or fixes yet.

## The bug

Agents doing heavy multi-turn work on prod die in a crash loop and then go silent for 6 hours:

1. A turn starts (`llm-request-requested`), then mid-turn the processor host DO dies (deploy-triggered facet restart or storage pressure).
2. Revival reopens event connections; the churn is journaled as stream events — thousands of `stream/connection-opened` / `stream/connection-closed` pairs (~1500 per revival cycle; one stream passed offset 8400, mostly churn).
3. Each revival replays a longer journal → a same-millisecond burst of `durable_object_storage_kv_get` + exec ops → "Durable Object storage operation exceeded timeout which caused object to be reset" (observed ×3 in otel, traceId `4aee37e27797b4054056b351cf5715c8`).
4. After 3 consecutive revival failures on one deploy version: `stream/error-occurred` — "processor host revival has failed 3 consecutive times on version <uuid>; backing off (plateau 360m). A deploy resets the budget." Agent sits silent for 6h.

Secondary observations on the wedged stream:

- `processor.snapshot()` fails with "Subrequest depth limit exceeded. This request recursed through Workers too many times."
- "LLM request @158 failed (attempt 1 of 3): LLM attempt timed out after 0.1511 minutes. Retrying." — a ~9s deadline where minutes are expected, suggesting deadlineMs computed from a nearly-exhausted budget with no floor.
- Heavy work succeeds on local dev; small single-turn work succeeds on prod. The killer is journal size / storage pressure, not specific inputs.

Note PR #2408 recently made ephemeral stream events memory-only — yet connection churn still hits durable storage in this path. Part of the investigation is finding why.

## Mechanisms to pin with tests (red → green)

- [ ] (a) N revive/reconnect cycles must not grow the durable journal superlinearly — connection churn capped, coalesced, or ephemeral
- [ ] (b) revival replay storage work bounded regardless of stream length (counting storage fake via dependency injection, not vi.mock)
- [ ] (c) revival-failure backoff surfaces an actionable state and is resettable without a deploy
- [ ] (d) LLM deadline has a sane floor if confirmed it can compute near-zero

## Plan

- [ ] Investigate: where connection-opened/closed events are appended; why they're durable post-#2408
- [ ] Investigate: revival path in `apps/os/src/domains/processor-facet-durable-object.ts` — replay storage access pattern, 3-strikes backoff, plateau 360m
- [ ] Investigate: `agent-llm-request.ts` / `agent-turn-loop.ts` deadline computation
- [ ] Write failing tests for each confirmed mechanism (node test harness per docs/writing-stream-processors.md)
- [ ] Fix smallest credible subset; defer invasive pieces explicitly here + in PR body
- [ ] Full check suite: typecheck, lint, knip, format, test

## Implementation log

- 2026-08-12: task file created; investigation starting.
