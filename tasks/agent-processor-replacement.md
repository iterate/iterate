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
  `subscription-configured` events naming `processorSlug: "agent"`; the
  registry hosts by slug, and same-slug idempotency keys make already-rendered
  per-event consequences in old journals DEDUPE instead of re-running. The
  `agent-next` slug existed only to avoid key collisions while both
  processors existed; the replacement ends that.
- **State schema changes freely.** A persisted fold that fails the new
  schema's parse triggers a refold from the journal; the delivery CURSOR
  survives, so old events are re-REDUCED but never re-delivered to
  processEvent.
- **Old journals must refold correctly.** Two landmines found in the audit:
  1. Old `agent/llm-request-completed` / `agent/llm-request-cancelled`
     events MUST be consumed as legacy settlement facts (fold arms that
     close a matching `openRequest`). Otherwise the first historical
     `llm-request-requested` opens a request that never settles, every later
     requested folds to nothing, and the assistant fold-guard drops every
     subsequent assistant turn — silent conversation loss on refold.
     `llm-request-scheduled` / `llm-request-started` stay unconsumed
     (skipped, harmless).
  2. The COMPACTION fold arm must be ported (a developer context item with
     `compaction.replacesHistoryThrough`): seal coverage through the
     barrier, drop history at or below it, retain latest keyed system
     occurrences. Otherwise compacted conversations refold into the full
     uncompacted prompt.
- **Context payload = superset of every historical shape.** The clean room's
  flat object gains the prod-only fields so ALL committed events parse:
  `refs` (event/user/file/git-commit), `compaction` (developer role),
  actor variants `slack`/`telegram`/`email`/`github` alongside
  user/agent/script/integration. A historical event that fails parse is
  SKIPPED from the fold — for context items that is conversation loss, so
  the payload schema is the compatibility contract.
- **Kept bridge events** (deferred collapse decisions from the jam):
  `agents/web-message-sent` (+ the mirror-into-context per-event append,
  `render-web-response@offset`), `agent/token-usage-reported` (emitted with
  the settled batch; feeds compaction trigger + lifetime totals fold + UI
  meter), `agent/summary-updated` (fold + conditional waiting-clear +
  wake-clears-waiting effect), `agent/binding-set` (contract-owned, folded
  by integrations not the agent). `agent/loop-stopped` is NOT kept — the
  breaker is `agent/paused`/`agent/resumed` now; historical loop-stopped
  events are unconsumed and skip.
- **Consumers update ADDITIVELY.** Old journals render forever, so the UI
  reducer, llm-request-replay, TUI feed model, mobile chat/feed keep their
  scheduled/started/completed/cancelled handling for history and GAIN
  settled/paused/resumed handling for new events.
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
- [ ] Steps 1–7
