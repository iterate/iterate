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
