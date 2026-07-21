---
state: in-progress
priority: high
size: medium
dependsOn: []
tags: [mobile, itx, iterate-package, consolidation]
---

# Move apps/mobile onto the shared itx client (`iterate/client` + `iterate/react`)

**Status summary:** implementation is starting on `mobile-shared-itx-react`. The
target is a behavior-preserving consolidation: mobile should consume the shared
keeper and React subscription hooks, deleting its local keeper/watchdogs. No
runtime behavior or screen UX is intentionally changing. The migration only
ships if the resulting ownership and code are materially simpler.

Mobile is the codebase's last hand-rolled itx transport — the "third keeper"
(PR #2063's reviews called it exactly that). It duplicates machinery the
shared client already owns, live-proven in the browser and the chat TUI:

- `apps/mobile/src/lib/itx-core.ts` + `itx.ts` — bespoke dial + cached-session
  keeper (error-driven reset, no liveness probes, no half-open detection).
- `apps/mobile/src/lib/live-thread.ts` (118 LOC) and `live-approvals.ts`
  (101 LOC) — two near-identical hand-rolled 15s ping-watchdog + resubscribe +
  `setQueryData` lifecycles, i.e. a worse `useItxSubscription` twice.

## What to do

- [ ] Replace the dial/keeper with `configureIterateSession` + `connectItx`
      from `iterate/react` (the React entry is deliberately the one-stop import
      for hooks and imperative calls). React Native's global WebSocket satisfies
      capnweb.
- [ ] Replace both watchdog lifecycles with `useItxSubscription` or
      `useLiveState` from `iterate/react`; keep initial reads and pushed-event
      cache behavior identical.
- [x] ~~Wire `AppState` → `focusManager.setFocused`.~~ _Landed in PR #2084 for native push-enrollment reconciliation._
- [ ] Wire native online state into TanStack's `onlineManager`, and call
      `reportTransportSuspicion()` on app foreground once mobile adopts the
      shared keeper.
- [ ] Re-point mobile's deep-relative `apps/os/src/itx-api.generated.ts` type
      imports at `iterate` too; nothing outside `apps/os` should reach into its
      generated contract source.
- [ ] Prove Metro resolves `iterate/react` without bundling a second React copy.
- [ ] Collapse mobile e2e's direct capnweb dials onto `iterate/node` where that
      reduces plumbing without weakening the production-code proof.
- [ ] Delete superseded mobile keeper/subscription modules and update nearby
      documentation.
- [ ] Run mobile typecheck/unit tests, shared-client tests, lint/format, Expo web
      bundling, and the live mobile e2e lane when local credentials are
      available.

## Behavior contract

- A remembered signed-in deployment still cold-opens to the remembered project
  only after verifying that project remains in scope.
- Users can sign in to or switch between production, preview, and custom
  deployments without restarting the app.
- Access tokens are refreshed at dial time, including after a transport
  reconnect; an auth-shaped initial failure retains the existing single retry.
- Chat and approval screens show the same initial event history, merge live
  batches by offset, recover after transport loss, and do not duplicate
  subscriptions.
- Signing out or changing deployment cannot leave the previous deployment's
  socket, authority, subscriptions, or cached data active.
- Project reads/actions and push-device enrollment keep their existing loading,
  error, retry, and navigation behavior.

## Simplification gate

The migration must remove the app-local transport keeper and the two duplicated
subscription watchdogs without replacing them with another mobile lifecycle
layer of comparable size. Shared-client changes are acceptable only when they
express a generally useful missing contract (for example, rotating credentials
or deliberate target replacement) and are covered in the package itself. If
preserving mobile's deployment switching and rotating OAuth credentials makes
the shared path more complicated overall, stop and ask whether consolidation is
still desired.

## Working assumptions

- `useItxQuery` is not mandatory where its Suspense contract would change a
  mobile screen's current spinner/error UX; ordinary TanStack queries may call
  the shared imperative `connectItx`.
- `useLiveState` is only appropriate for RPC surfaces already exposing live
  state. Event-history screens should use `useItxSubscription`, not change data
  models merely to adopt a named hook.
- Expo SDK 54 owns mobile's React version. The package integration must support
  that renderer rather than upgrading Expo/React as an incidental migration.

Proof: the mobile e2e suite drives the exact phone code from Node
(`apps/mobile/e2e/*.e2e.test.ts`) — same lane that proved the TUI.

Context: PR #2063 (the extraction), the consolidation-sweep findings in its
description, `docs/frontend-development.md`.
