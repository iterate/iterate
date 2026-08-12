---
status: in-progress
size: large
branch: processor-revival-spiral
---

# Processor host revival death spiral: repro + fix

## Status summary

Done, pending review. All four mechanisms pinned with tests (red→green in PR history) and fixed: presence facts are now ephemeral (journal growth killed), the keepalive backoff is resettable without a deploy, near-expiry LLM adoption settles expired, and same-version revival replay is pinned at zero journal reads. Deferred: an itx/admin door for `resetRecoveryBackoff` (the seam exists on the registry) and any dashboard surfacing of the plateau state.

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

- [x] (a) N revive/reconnect cycles must not grow the durable journal superlinearly — _connection-opened/closed are now `ephemeral: true` contract events (core-processor-contract.ts); red tests in core-processor.test.ts + stream-event-sender.test.ts_
- [x] (b) revival replay storage work bounded regardless of stream length — _already bounded (green pin): a same-version wake does one O(1) identity read and zero replay reads on a 1000-event journal (stream-processor-runner.test.ts); the unbounded input was (a)'s journal growth_
- [x] (c) revival-failure backoff surfaces an actionable state and is resettable without a deploy — _`ProcessorKeepalive.resetBackoff()` → `durableObjectRecovery.resetBackoff` → `registry.resetRecoveryBackoff(name)`; the plateau error event already surfaces the state_
- [x] (d) LLM deadline has a sane floor — _confirmed `deadlineMs = max(1, expiresAt - now)`; adoption with <30s validity now settles expired (agent-turn-loop.ts), pinned in agent-processor.test.ts_

## Plan

- [x] Investigate: where connection-opened/closed events are appended; why they're durable post-#2408 — _they were never marked ephemeral; validate hard-rejected ephemeral on all `stream/*` types_
- [x] Investigate: revival path — replay storage access pattern, 3-strikes backoff, plateau 360m — _keepalive in packages/iterate/src/processors/stream-processor-keepalive.ts; the revive pass only appends a fact, the replay burden was the churn-bloated journal_
- [x] Investigate: `agent-llm-request.ts` / `agent-turn-loop.ts` deadline computation — _confirmed the 9s anomaly_
- [x] Write failing tests for each confirmed mechanism
- [x] Fix smallest credible subset; defer invasive pieces explicitly here + in PR body
- [x] Full check suite: typecheck, lint, knip, format, test

## Deferred

- itx/admin door for `resetRecoveryBackoff` (registry seam exists; wiring through the facet's RPC surface + CLI is a follow-up)
- UI surfacing of the plateau state beyond the existing `stream/error-occurred` fact
- Investigating the secondary "Subrequest depth limit exceeded" on `processor.snapshot()` (likely a symptom of the storage-wedged DO, not a separate bug)

## Findings (2026-08-12 investigation)

- (a) **Why churn is durable post-#2408**: `stream/connection-opened`/`connection-closed` are defined in `CoreProcessorContract` (apps/os/src/domains/streams/core-processor-contract.ts:674) WITHOUT `ephemeral: true`, and `StreamCoreProcessor.validate` (core-processor.ts:187) hard-rejects `ephemeral` on ANY `events.iterate.com/stream/*` type. So every open/close appended by the sender (stream-event-sender.ts:2155, :2417) and the pager close (stream-durable-object.ts:3114) is a durable SQLite journal row. Yet the core reducer folds them into NOTHING (core-processor.ts:474-482 — parse and return state unchanged); the contract descriptions themselves say runtime connection state is authoritative and close facts are best-effort. Presence facts are pure churn in the durable log. Session (browser) reconnect storms against a wedged stream have no persisted backoff, so a crash-looping DO journals unbounded open/close pairs — the ~1500/cycle growth.
- (b) **Replay cost**: stream DO boot folds journal pages past the debounced KV checkpoint (64 events / 1s lag bound — stream-durable-object.ts:2456), and hosted runners refold reduce-only from offset 0 only on contract-version change (`#rebuildReduction`, stream-processor-runner.ts:1112). Both are checkpoint-accelerated; the unbounded input is the journal growth from (a). Agent prompt building (`readConsumedEvents`, agent-llm-request.ts:338) pages the consumed subset from offset 0 every turn — O(history), by design, but filtered by `consumes` so (a)'s churn does not inflate it.
- (c) **Backoff reset**: `ProcessorKeepalive` (packages/iterate/src/processors/stream-processor-keepalive.ts) resets its crash-loop budget ONLY on quiet-clean confirmation or worker-version change. At 3 strikes it appends the plateau error fact and next retry is 6h out. No seam exists to reset it without a deploy.
- (d) **9s LLM deadline confirmed**: `deadlineMs: Math.max(1, open.expiresAt - now)` (agent-llm-request.ts:157). `expiresAt` anchors to the trigger (trigger + 10m default). A request adopted by a late revival with e.g. 9s of validity left runs a doomed attempt (and its retries) instead of settling expired — the adoption check (agent-turn-loop.ts:298) only rejects when validity is fully exhausted.

## Implementation log

- 2026-08-12: task file created; investigation complete, findings above.
- 2026-08-12: red tests committed (all but the (b) pin fail on main), then fixes. One migration subtlety: marking a definition `ephemeral: true` made `parseEvent` default the flag onto HISTORICAL durable rows (caught by the frozen v31 replay test — eventCount drifted). Fixed by making committed-event parsing keep the stored flag verbatim; only input parsing forces the definition's choice.
- 2026-08-12 (preview CI red): the stream-browser playwright suite exposed a second real bug — the browser raw-events table used `local_index = offset - 1` while the virtualized list windows indexes `0..count-1` over it, so the new ephemeral offset gaps made every row after a connection open/close invisible. Fixed by allocating `local_index` densely at insert (schema v8 rebuild); spec counts updated to drop presence facts. Full suite verified green against local vite dev.
