---
state: complete
priority: high
size: medium
dependsOn: []
tags: [mobile, itx, iterate-package, consolidation]
---

# Move apps/mobile onto the shared itx client (`iterate/client` + `iterate/react`)

**Status summary:** complete on `mobile-shared-itx-react`. Mobile now consumes
the shared keeper and `useItxSubscription`; its local dialer and two watchdogs
are deleted. Shared lifecycle coverage, native/web bundles, browser smoke, and
deployment-backed mobile round trips pass. Production code is 58 lines smaller
overall, including the new reusable shared lifecycle contracts.

Mobile is the codebase's last hand-rolled itx transport — the "third keeper"
(PR #2063's reviews called it exactly that). It duplicates machinery the
shared client already owns, live-proven in the browser and the chat TUI:

- `apps/mobile/src/lib/itx-core.ts` + `itx.ts` — bespoke dial + cached-session
  keeper (error-driven reset, no liveness probes, no half-open detection).
- `apps/mobile/src/lib/live-thread.ts` (118 LOC) and `live-approvals.ts`
  (101 LOC) — two near-identical hand-rolled 15s ping-watchdog + resubscribe +
  `setQueryData` lifecycles, i.e. a worse `useItxSubscription` twice.

## What to do

- [x] Replace the dial/keeper with `configureIterateSession` + `connectItx`
      from `iterate/react` (the React entry is deliberately the one-stop import
      for hooks and imperative calls). React Native's global WebSocket satisfies
      capnweb. _`apps/mobile/src/lib/itx.ts` is now only the OAuth/deployment binding._
- [x] Replace both watchdog lifecycles with `useItxSubscription` or
      `useLiveState` from `iterate/react`; keep initial reads and pushed-event
      cache behavior identical. _`use-live-events.ts` preserves query keys,
      offset merging, replay cursors, and error/refetch behavior while the shared
      hook owns reconnect/watchdog/teardown._
- [x] ~~Wire `AppState` → `focusManager.setFocused`.~~ _Landed in PR #2084 for native push-enrollment reconciliation._
- [x] Call `reportTransportSuspicion()` on app foreground once mobile adopts the
      shared keeper. _The existing `AppState` listener now probes the transport._
- [x] ~~Add a separate native online-state integration.~~ _Omitted deliberately:
      mobile has no NetInfo/expo-network dependency, and adding one would change
      runtime behavior rather than consolidate it. The shared 45-second verifier
      plus foreground probe preserves the existing contract._
- [x] Re-point mobile's deep-relative `apps/os/src/itx-api.generated.ts` type
      imports at `iterate` too; nothing outside `apps/os` should reach into its
      generated contract source. _Mobile imports generated types from
      `iterate/react`; its Node e2e lane uses `iterate/node`._
- [x] Prove Metro resolves `iterate/react` without bundling a second React copy.
      _Metro pins React and TanStack Query to the app-owned runtime; clean web and
      iOS exports contain Expo's React 19.1 and no package-local React 19.2._
- [x] Collapse mobile e2e's direct capnweb dials onto `iterate/node` where that
      reduces plumbing without weakening the production-code proof. _All three
      live specs use owned `connectItx` handles and still pass against local OS._
- [x] Delete superseded mobile keeper/subscription modules and update nearby
      documentation. _Deleted `itx-core.ts`, `live-thread.ts`, and
      `live-approvals.ts`; updated mobile and frontend-development docs._
- [x] Run mobile typecheck/unit tests, shared-client tests, lint/format, Expo web
      bundling, and the live mobile e2e lane when local credentials are
      available. _Root test/typecheck/lint/knip/format pass; 47 mobile unit tests,
      153 shared-client tests, five live mobile e2e tests, the headed mobile
      Playwright smoke, and clean Expo web/iOS exports pass._

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

## Implementation notes

- The shared keeper accepts a credential provider resolved on every dial,
  retries one auth-shaped rejection with `forceRefresh: true`, replaces a live
  session immediately when its configured deployment changes, and exposes an
  explicit disconnect for native sign-out. Package tests cover each boundary.
- App-owned connection/live-subscription code fell from 295 lines across
  `itx-core.ts`, `itx.ts`, `live-thread.ts`, and `live-approvals.ts` to 109 lines
  across the mobile binding and query-cache adapter. Including the reusable
  shared contracts and Metro singleton rule, production code is net -58 lines.
- Browser smoke initially failed before tests started. Diagnostic server logs
  showed a transient Playwright launch failure; an exact rerun brought up both
  servers and passed. Metro consistently waits 60 seconds for this worktree's
  unhealthy Watchman before its successful node-crawler fallback; that
  pre-existing tooling issue is unrelated to the migration.
- The first pushed implementation passed `tsgo --noEmit` but package declaration
  generation used stricter closure narrowing for the credential-provider union.
  Capturing the narrowed provider fixed the publish build without changing
runtime behavior; the exact `packages/iterate` build now passes locally.
