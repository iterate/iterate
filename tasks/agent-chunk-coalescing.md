---
status: ready
size: medium
---

# Coalesce agent LLM chunk journaling

## Status

Implementation complete, checks running. Contract gained the plural
`llm-response-chunks` event; `agent-llm-request.ts` buffers and flushes;
UI reducer and replay lib fold both lanes; specs cover window grouping,
size-cap flush, backpressure ordering, and the interrupt partial. Contract
`version` intentionally NOT bumped: it identifies the prompt fold (drives the
replay "reconstructed" label) and the fold is byte-identical.

## Problem

Prod agents stream at ~15–19 tok/s regardless of model, while the same models
serve 51–60 tok/s to a laptop and 54–57 tok/s to a plain fetch from inside the
prod worker. Measured cause: the agent lane journals every streamed provider
chunk with an **awaited** Durable Object append (~60ms p50, measured in-worker),
and the transport drain awaits `onChunk` before reading the next SSE frame —
so throughput is capped at one token per append round-trip
(1000ms / 60ms ≈ 17 tok/s). Benchmarks: 4 prod agent turns per model
(gpt-5.6-terra 15.2–19.0 tok/s, grok-4.6 content phase 18.4–19.2 tok/s), chunk
cadence 52–68ms in every run.

## Fix

Buffer chunks in the agent's `onChunk` and journal one multi-delta ephemeral
event per ~150ms window. The ~60ms commit amortizes over ~8 tokens → ceiling
~130 tok/s, above provider rates. UI updates ~7×/sec.

## Decisions (from the grill)

1. Coalescing lives in `agent-llm-request.ts` `run()`'s `onChunk`, not the
   transport drain; compaction's noop `onChunk` untouched.
2. The flush append stays awaited — ordering trivial, socket absorbs the
   commit, failures surface at the flush. No pipelining machinery.
3. Ephemerality unchanged: new event is forcibly ephemeral in the contract;
   durable truth stays the `context-added`/`llm-request-settled` pair.
4. Voice lane unaffected (verified: nothing in voicelab/voice-agent reads
   chunk events).
5. Interrupt path safe: `inFlight.partialText` accrues per provider chunk
   before buffering, so cancelled turns keep their full partial.
6. New plural event type `events.iterate.com/agent/llm-response-chunks`,
   payload `{ chunks: [...verbatim provider chunks], llmRequestOffset,
   sequence }`. Singular type stays as a legacy parse lane.
7. Flush policy: ≥150ms elapsed since last flush (clock = `host.now()`) OR
   ≥64KB serialized buffer; tail flush before the success settle; no timers.
8. Stale-tab exposure accepted: old bundles show no live text for one deploy
   window; final messages unaffected (durable events unchanged).
9. Node-harness TDD; draft PR with the benchmark numbers.

## Checklist

- [x] Contract: add `agent/llm-response-chunks` (ephemeral-forced), keep singular as legacy — _`agent-processor-contract.ts`, singular marked LEGACY, plural added to `emits`_
- [x] Harness specs: window grouping, tail flush before settle, interrupt keeps partial, size-cap flush — _three new/rewritten specs in `agent-processor.test.ts`; existing interrupt spec already covers the partial_
- [x] `agent-llm-request.ts`: buffer + flush in `onChunk`, tail flush before settle — _window anchored at request start so the first post-TTFT chunk flushes immediately; best-effort tail flush on the failure path too_
- [x] UI reducer (`packages/ui/.../agent-ui-reducer.ts`): fold plural events (keep singular lane) — _shared case iterates the window_
- [x] Replay lib (`apps/os/src/lib/llm-request-replay.ts`): reassemble from plural events (keep singular lane) — _windows deduped by flush sequence then flattened_
- [x] `pnpm typecheck && pnpm lint && pnpm knip && pnpm format && pnpm test` — _all green; one existing fake-model spec updated for the plural events_
- [x] Draft PR with before/after tok/s numbers — _#2531_
- [x] Smooth token reveal in the live feed — _CSS-staggered `TokenRevealText` over reducer-kept `responseWindows`; requested after Misha felt the 8-token jumps on preview-8_
