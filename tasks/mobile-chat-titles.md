---
status: in-progress
size: small
---

# Mobile: show chat titles instead of raw stream paths

**Status summary:** implementation complete; PR open. Server exposes agent
titles through `itx.agents.list()`, mobile renders them in the chat list and
thread header. Remaining: review.

Prompted by a screenshot of the mobile chat list showing rows like
`mobile/2026-08-12t23-27-59-114z` — the raw agent stream path — where a
human-readable title should be. Agents already set a title on their first
turn (`agent/summary-updated`, per `AGENT_SUMMARY_INSTRUCTION`), and the web
sidebar shows it; mobile just had no way to read it: `itx.agents.list()`
returned only `path` + `createdAt`.

## Checklist

- [x] Expose `title` from `itx.agents.list()` _new `AgentListItem` type in
      `apps/os/src/domains/agents/agent-presence.ts`; `list()` in
      `rpc-targets.ts` maps `summary.title` through; regenerated the itx API
      projections with `pnpm generate:itx-api`_
- [x] Chat list rows render the title _`apps/mobile/.../index.tsx`: title in
      normal weight, mono path fallback for chats whose agent has not set one
      yet_
- [x] Thread header renders the title _`apps/mobile/.../chat.tsx`: folded
      from the already-loaded event stream via new `latestAgentTitle` in
      `lib/chat.ts` (same set/clear/preserve semantics as
      `threadContextForScriptRun`); raw path stays reachable via the •••
      menu_
- [x] Tests _`latestAgentTitle` cases added to
      `apps/mobile/src/lib/chat.test.ts`_

## Decisions / assumptions

- Fixed the product surface rather than having mobile dig into
  `agents.liveState`: the title is public catalog data and every list()
  consumer benefits. `title` is optional on the wire — absent until the
  agent's first turn lands — so clients keep a path fallback.
- Chat screen derives its header title client-side from events it already
  fetches (no extra request, updates live as summary events stream in).

## Implementation log

- `agents.list()` e2e assertions (`itx-agents.e2e.test.ts`) use
  `objectContaining`/empty-list — tolerant of the added field, no changes
  needed.
- Root-worktree typecheck noise encountered along the way, none of it from
  this change: stale expo route typegen + missing `expo-media-library` in
  apps/mobile, `*ignoreme*` scratch files in apps/os.
