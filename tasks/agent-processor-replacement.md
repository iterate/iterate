---
state: doing
priority: high
size: large
dependsOn: []
---

# Replace the production agent processor with the clean-room implementation

The clean room (`apps/os/src/domains/agents/next/`, merged in #2154) becomes
THE agent processor. This is an in-place, flag-day replacement — not a
parallel run.

## Locked decisions

- **Slug stays `"agent"`.** Existing agent streams carry durable
  `subscription-configured` events named `"agent"` (the subscription NAME is
  the contract selector); the
  registry hosts by slug, and same-slug idempotency keys make already-rendered
  per-event consequences in old journals DEDUPE instead of re-running. The
  `agent-next` slug existed only to avoid key collisions while both
  processors existed; the replacement ends that.
- **State schema changes freely.** A persisted fold that fails the new
  schema's parse triggers a refold from the journal; the delivery CURSOR
  survives, so old events are re-REDUCED but never re-delivered to
  processEvent.
- **NO historical compatibility** (Jonas, review round 2026-07-20 —
  supersedes the two "old journals must refold" landmines and the
  "consumers update additively" rule below as originally written): old
  journals are NOT required to parse, refold, or render. The legacy
  vocabulary (`llm-request-scheduled`/`started`/`completed`/`cancelled`,
  `loop-stopped`, cancel reason `durable-object-crashed`) is deleted
  everywhere — no legacy consumes, no bridge fold arms, no legacy UI
  handling. UIs render ONLY the new types. `refs`, the
  slack/telegram/email/github actor variants, and `compaction` stay in the
  context payload as LIVE features (integration provenance lanes and the
  compaction rewrite), not as compatibility.
- **Kept live events** (deferred collapse decisions from the jam):
  `agents/web-message-sent` (+ the mirror-into-context per-event append,
  `render-web-response@offset`), `agent/token-usage-reported` (emitted with
  the settled batch; feeds compaction trigger + lifetime totals fold + UI
  meter), `agent/summary-updated` (fold + conditional waiting-clear +
  wake-clears-waiting effect), `agent/binding-set` (contract-owned, folded
  by integrations not the agent). `agent/loop-stopped` is NOT kept — the
  breaker is `agent/paused`/`agent/resumed` now; historical loop-stopped
  events are unconsumed and skip.
- **Consumers render only the new vocabulary** (superseding the earlier
  additive plan): settled/paused/resumed/processor-revived handling only;
  every legacy case deleted.
- **Ported user-space machinery** (from the audit inventory): prompt
  building (protocol prompt, system-prompt-policy gate — no turn until the
  canonical `agent/system-prompt` keyed slot exists, trust demotion incl.
  the integration actor variants, timestamp-last), workers-ai transport
  behind the injected seam (unified + BYOK gateway, raw chunk objects in
  `llm-response-chunk.chunk`, usage normalization, containsFiles cache
  skip), script extraction with prod's multi-block/malformed feedback,
  script-result spill-to-workspace (`/script-results`, 30k limit),
  `resolveModelFileUrl` file preparation, AgentLiveState `runtimeChange`
  derivation (scheduled count pins to 0 in the new model; openRequest maps
  to `requested`).

## Work plan

1. Move `next/` → `domains/agents/` replacing `agent-processor-contract.ts`
   + `agent-processor-implementation.ts`; slug `"agent"`; delete the old
   files and the `next/` dir + knip exception.
2. Contract: superset context payload, legacy-settlement consumes, bridge
   events, compaction field.
3. Implementation: legacy fold arms, compaction (fold + trigger + summary
   turn), web-message mirror, token-usage emission + totals, summary fold +
   waiting-clear, prompt building, transport adapter, spill, live state.
4. Rewire: `agent-durable-object.ts` (same deps), `agent-defaults.ts`
   (same event names — verify payloads), collection processor, rpc-targets
   create flow, `event-docs.ts`.
5. Consumers: `packages/ui` agent-ui-reducer, `llm-request-replay.ts`,
   TUI feed model, mobile chat/feed, stream-feed-filters — additive.
6. Tests: the clean-room step-harness suite moves in as the primary suite,
   extended with ported feature tests (compaction, summary, web-message,
   token-usage, legacy-journal refold). Old `agent-processors.test.ts` /
   `agent-eviction-recovery.test.ts` are replaced; salvage any scenario not
   yet covered. A dedicated REFOLD test feeds a captured old-format journal
   through the new reduce.
7. Regenerate itx-api; typecheck/lint/knip/test; e2e.

## Status

- [x] #2154 merged (4fae30c14); branch `agent-processor-replacement` off main
- [x] Steps 1–7 complete: clean room moved in under slug "agent" (contract
  v5.0.0), superset context payload + legacy settlement consumes + compaction
  fold + bridge events all in place; prompt building, workers-ai transport
  seam, script feedback/spill, live-state derivation ported; consumers
  (shared UI reducer → TUI/mobile/projector, llm-request-replay) additive;
  e2e state-shape reads updated; docs examples on all 14 owned events with
  the docs path pinned to "agents" (first-event namespace); itx-api
  regenerated; full apps/os suite (2002 tests), packages/iterate (148),
  typecheck, lint, knip green.
