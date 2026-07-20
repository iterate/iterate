---
state: todo
priority: high
size: medium
dependsOn: []
tags: [mobile, itx, iterate-package, consolidation]
---

# Move apps/mobile onto the shared itx client (`iterate/client` + `iterate/react`)

**Status summary:** not started overall. PR #2084 already wired React Native `AppState` into TanStack Query's `focusManager`, so foreground query reconciliation is no longer part of this task. The shared transport keeper, subscription hooks, online/suspicion signals, package type imports, and e2e dialing consolidation remain.

Mobile is the codebase's last hand-rolled itx transport — the "third keeper"
(PR #2063's reviews called it exactly that). It duplicates machinery the
shared client already owns, live-proven in the browser and the chat TUI:

- `apps/mobile/src/lib/itx-core.ts` + `itx.ts` — bespoke dial + cached-session
  keeper (error-driven reset, no liveness probes, no half-open detection).
- `apps/mobile/src/lib/live-thread.ts` (118 LOC) and `live-approvals.ts`
  (101 LOC) — two near-identical hand-rolled 15s ping-watchdog + resubscribe +
  `setQueryData` lifecycles, i.e. a worse `useItxSubscription` twice.

## What to do

- Replace the dial/keeper with `configureIterateSession({ baseUrl,
  credentials })` + `connectItx` from `iterate/client` (React Native's global
  WebSocket satisfies capnweb — the module says so itself).
- Replace both watchdog lifecycles with `useItxSubscription` /
  `useLiveState` from `iterate/react` (renderer-agnostic; RN is the
  officially-supported TanStack Query precedent).
- [x] ~~Wire `AppState` → `focusManager.setFocused`.~~ _Landed in PR #2084 for native push-enrollment reconciliation._
- Wire NetInfo/expo-network → `onlineManager` (TanStack's documented RN
  pattern), and call `reportTransportSuspicion()` on app foreground for the
  shared keeper once mobile adopts it.
- Re-point mobile's 10 deep-relative `apps/os/src/itx-api.generated.ts` type
  imports at the package too (absorbed from the deleted
  generated-contract-imports-via-package task; the streams-example-app half
  shipped in #2069) — after which nothing outside `apps/os` reaches into its
  source tree for the contract.
- Metro must resolve the package's subpath exports (`iterate/client`,
  `iterate/react`); check `unstable_enablePackageExports` behavior.
- Mobile's e2e also hand-dials `newWebSocketRpcSession` four times
  (approval-roundtrip ×2, chat-roundtrip, example-runner) — collapse onto
  `iterate/node`.

Proof: the mobile e2e suite drives the exact phone code from Node
(`apps/mobile/e2e/*.e2e.test.ts`) — same lane that proved the TUI.

Context: PR #2063 (the extraction), the consolidation-sweep findings in its
description, `docs/frontend-development.md`.
