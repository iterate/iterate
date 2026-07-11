---
title: Streaming UI wedges after mobile suspend/resume; reload fixes it
state: in-progress
created: 2026-07-11
---

# Streaming UI wedges after suspend/resume

**Symptom (Jonas):** start a long agent task on mobile Safari, close Safari,
come back a bit later — the stream feed is stuck. Reloading the page "resumes"
it correctly. Happens "quite often".

## Theories under investigation

### T1 — Dead-transport capture: the stream runtime can never reach a fresh socket (PRIMARY)

Chain, from code reading (2026-07-11):

1. `apps/os/src/components/project-stream-view.tsx:114-124` — the browser
   stream client factory closes over the `useItx()` handle captured at mount:
   `(path) => itx.streams.get(path)`.
2. `apps/os/src/itx/itx-react.tsx` — the `/api` WebSocket is memoized in a
   module-level map; the entry is only evicted on a `close` event or
   `reconnectAllItx()` (which only `useItxSubscription` watchdogs call — the
   feed stack doesn't use that hook).
3. `apps/os/src/domains/streams/client-libraries/browser/stream-browser-store.ts:206`
   — `acquireStreamRuntime` dedupes by `(projectId, streamPath, slug)` and
   **ignores the new `createStreamClient` factory** for an existing runtime.

So when the socket dies (mobile Safari kills TCP during suspend):

- **Close event delivered** (typical on resume): capnweb breaks the session,
  the itx socket map evicts and React gets a _fresh_ itx handle — but the
  already-registered stream runtime keeps its mount-time factory, whose stub
  rides the broken session. Its liveness probe fails (~2 probe intervals,
  ~20s), `scheduleReconnect` → `connect()` → `createStreamClient` → rejects
  ("RPC session broken") → reconnect in 1s → rejects → **loops forever**.
- **No close event** (half-open): every RPC hangs; probe timeouts (2 strikes)
  force reconnect, but `connect()` awaits `itx.streams.get()` on the half-open
  socket with **no deadline** (`stream-browser-store.ts:583`) → parked forever,
  or falls into the same loop when the close finally lands.

Reload (or SPA navigation away+back, which disposes the runtime at listener
refcount 0) creates a fresh runtime with a fresh factory → works. Matches the
symptom exactly.

### T2 — No proactive resume signal

`stream-browser-store.ts` has no `visibilitychange`/`pageshow`/`online`
handlers; detection waits for the 10s-interval probe (which mobile browsers
freeze while backgrounded). Even with T1 fixed, resume-to-recovery latency is
one-to-two probe intervals. (`useItxSubscription` in itx-react _does_ have
these handlers — the feed stack doesn't.)

### T3 — UI-only stall: data lands in SQLite but the feed doesn't repaint/pin

`use-stick-to-bottom.ts` re-pins via ResizeObserver only; reactive queries
notify via coalesced 16ms timers. If everything data-side recovers but the
observer chain was frozen, the feed could look stuck while the mirror is
current. Secondary — reload wouldn't be _required_ for data, but user-visible.

### T4 — OPFS worker / Web Lock casualties of suspension

The SQLite mirror lives in a Worker over OPFS; the writer role is a Web Lock.
iOS may kill workers or release locks on suspended pages. If the writer-lock
election or db worker wedges on resume, ingest fails → reconnect loop
interacts with T1.

## Plan

1. Failing Playwright repro in `specs/` (fixture project + admin itx appends;
   kill/suspend transport variants: forced WS close, offline/online,
   CDP `Page.setWebLifecycleState` frozen→active). Prove the wedge in CI-shaped
   tests, not just on a phone.
2. Confirm mechanism via `__streamRuntimeDebug()` instrumentation.
3. Fix (likely: per-call fresh transport resolution + runtime factory refresh
   on re-acquire + transport-reset escalation on repeated connect failures +
   visibility fast-probe), keeping the repro specs as regression tests.
4. Verify against a preview deployment, including a real phone-shaped run.

## Journey log

- 2026-07-11: Theories drafted from code reading; T1 confirmed statically
  (factory capture + registry dedupe + eviction rules). Repro specs next.
- 2026-07-11 (later): **T1 confirmed empirically** on local dev via
  `specs/stream-resume-after-suspend.spec.ts`:
  - control (healthy append → delivery): PASS, 6.5s.
  - clean WS close: FAIL as predicted — probe notices at ~20s
    (`connection failed its liveness probe; reconnecting Error: Peer closed
WebSocket: 1005`), then both runtimes wedge forever in
    `connectionStatus: "reconnecting"`,
    `connectionError: "connect failed: Peer closed WebSocket: 1005"`,
    `hasConnection: false`; server-appended marker never delivered in 60s.
  - freeze (CDP `Page.setWebLifecycleState`) + offline + thaw: FAIL with the
    identical wedge signature.
    The itx socket map re-dials fine (page chrome recovers); only the stream
    runtimes stay dead — precisely the reported UX.
- 2026-07-11 (fix): adversarial audit CONFIRMED T1 on all five axes (capnweb
  abort is terminal + no auto-reconnect; nothing remounts the view; React
  keeps uSES subscriptions across Suspense so no accidental dispose-heal;
  composer sends SUCCEED via fresh `connectItxBrowser` while the feed stays
  wedged — the crueler UX; `unsubscribe()` on a broken session rejects async,
  no sync-throw hazard). T3 REFUTED (repaint chain sound; multi-tab
  follower-of-a-frozen-writer is a real but separate lane). T4 PARTIAL (db
  worker death is undetected — no onerror — separate latent hazard).
  Fix shipped: per-call transport resolution (view + admin source), factory
  refresh on re-acquire, 15s dial deadline, StepTimeoutError-classified
  transport eviction via `resetTransport` (wired to `reconnectItx(address)`),
  probe rejections reconnect on first hit, resume listeners
  (visibilitychange/online/pageshow → immediate nudge/reconnect), escalating
  connect backoff. All four specs green locally (clean close ~30s recovery,
  freeze ~56s, half-open ~40s — the mute-the-socket trick simulates a
  suspend-killed TCP connection with no close frame).
- 2026-07-12 (thermo hardening): two thermo-nuclear reviews (structure +
  edge-case lenses), both NOT APPROVED first pass; all blockers fixed:
  - Election-chain timeouts now evict (a cached corpse "dials" instantly, so
    the election is where a not-subscribed half-open death manifests —
    previously an eviction-free 16s reconnect loop forever). One
    `reconnectAfterError` decision point replaces the scattered
    `instanceof StepTimeoutError` checks.
  - `reconnectItx` now CLOSES the WebSocket (it disposed only the derived
    stub; capnweb tears a session down on transport close only) — pending
    composer sends/queries reject instead of hanging on a ghost session, and
    evicted sockets no longer leak.
  - New `evictItxSocket` (young-socket guard, <15s can't be the corpse)
    prevents the two runtimes' staggered strikes from killing each other's
    fresh dials.
  - Followers (Web-Lock losers, no probe) now recover: `callWhenReady` wraps
    calls in a 20s deadline + broken-session classification that clears the
    corpse, and `onResume` gives followers a two-strike transport check.
  - Nudge held to the probe's two-strike standard (single 5s timeout no
    longer rips the shared socket); `pageshow` no longer restarts a young
    in-flight dial; stream stubs get their real dispose (cap-table leak).
  - Transport = ONE value ({createStreamClient, resetTransport}) refreshed
    wholesale on re-acquire via the registry (off the public store type).
    All specs green incl. new composer-send-after-recovery assertion.
