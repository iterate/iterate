---
status: done
size: medium
---

# Mobile: show chat titles instead of raw stream paths

**Status summary:** done — PR #2490, CI fully green (preview e2e included),
zero review threads. Server exposes agent titles through
`itx.agents.list()`, the mobile chat list renders them and stays LIVE off
the agent catalog's push channel, the thread header folds the title from
the event stream. Along the way this exposed and fixed a pre-existing
platform flaw: subscribing to `agents.liveState` on a fresh project (zero
chats) errored and stayed dead.

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
- [x] Chat list goes LIVE _`useLiveState((itx) => itx.agents.liveState)`
      takes over after the `list()` first paint — titles pop in on push, and
      chats started on web/Slack appear without navigation refetches (the
      spec exposed that returning from a chat showed a stale list)_
- [x] Thread header renders the title _`apps/mobile/.../chat.tsx`: folded
      from the already-loaded event stream via new `latestAgentTitle` in
      `lib/chat.ts` (same set/clear/preserve semantics as
      `threadContextForScriptRun`); raw path stays reachable via the •••
      menu_
- [x] Platform fix: `agents.liveState` on a fresh project _subscribing
      before the first agent create() was refused with
      `stream-subscription-unconfigured` and the watcher stayed dead (latent
      in the dashboard sidebar too); `AgentCollectionLiveStateRpcTarget` in
      `rpc-targets.ts` now appends the idempotency-keyed birth batch on
      exactly that refusal and retries once_
- [x] Tests _`latestAgentTitle` unit cases in `apps/mobile/src/lib/chat.test.ts`;
      RN-web spec `specs/mobile/chat-titles.spec.ts` (signup → new chat →
      path fallback → `/script` appends the summary fact with ZERO model
      turns → title takes over header and list); e2e
      `live-state.e2e.test.ts` "subscribed before any agent exists" guards
      the platform fix; `specs/mobile/notifications.spec.ts` heading
      assertion updated for the now-titled header_

## Decisions / assumptions

- Fixed the product surface rather than having mobile dig into reduced
  state ad hoc: `title` is public catalog data, every `list()` consumer
  benefits, and the live list rides the same `useLiveState` primitive the
  dashboard sidebar uses.
- `title` is optional on the wire — absent until the agent's first turn
  lands — so clients keep a path fallback.
- The platform fix is birth-on-refusal (not birth-on-every-subscribe): the
  already-born common path pays nothing; only the fresh-project refusal
  triggers the idempotent birth batch append + one retry.

## Implementation log

- `agents.list()` e2e assertions (`itx-agents.e2e.test.ts`) use
  `objectContaining`/empty-list — tolerant of the added field, no changes
  needed.
- The chat-titles spec failed twice before going green: first on the stale
  list after `goBack` (fixed by the live list), then on the fresh-project
  liveState refusal (fixed by the platform change). Verified the push
  mechanics with a throwaway node script before wiring the UI.
- CI's preview lane failed on `notifications.spec.ts` waiting for a heading
  named `elsewhere-thread` — that spec seeds a summary title, so the header
  now (correctly) shows the title instead; assertion updated.
- Root-worktree typecheck noise encountered along the way, none of it from
  this change: stale expo route typegen + missing `expo-media-library` in
  apps/mobile, `*ignoreme*` scratch files in apps/os.
