# High level findings

## SOLVED: sqlite-wasm OPFS froze in production builds because cross-origin isolation triggered the async-proxy VFS auto-install

**Symptom:** The browser SQLite mirror (SQLocal → `@sqlite.org/sqlite-wasm`) worked under
`vite dev` but **the SQLocal worker froze on the first SQL statement in every production
build** (`vite preview`, `wrangler dev`, `wrangler deploy`). The page subscribed and the
browser-hosted processor received events (`__receivedEventCount > 0`), but `Events` stayed
`0` and `Storage` stayed `pending` forever.

**Root cause (confirmed):** `@sqlite.org/sqlite-wasm`'s default "opfs" VFS uses a nested
**classic** async-proxy worker (`sqlite3-opfs-async-proxy.js`) + a `SharedArrayBuffer` /
`Atomics.wait` handshake. SQLocal's vite plugin forces `worker.format:'es'` on ALL workers,
so in a production build Rollup emits that proxy as an **ES module** while sqlite-wasm still
instantiates it as a **classic** `new Worker(...)` → parse error → the proxy never signals
ready → the SQLite worker **deadlocks in `Atomics.wait`** (synchronous; no `setTimeout`
guard can fire). Under `vite dev` the proxy is served unbundled/classic so it parses — hence
the dev-vs-prod split. Crucially, `sqlite3InitModule()` **auto-installs that async "opfs"
VFS during init whenever `SharedArrayBuffer` exists** — so even after patching SQLocal to the
proxy-free `opfs-sahpool` VFS, it still froze, because we had _added_ COOP/COEP → the page was
cross-origin-isolated → SAB present → the broken proxy spun up _before_ the SAH-pool code ran.

**Fix (confirmed on `vite preview` AND `wrangler deploy`, 2026-06-02):** **Remove
cross-origin isolation.** With no COOP/COEP there is no `SharedArrayBuffer`, so
`sqlite3InitModule()`'s OPFS auto-install early-rejects cleanly without ever spawning the
proxy worker, and the patched `opfs-sahpool` VFS (which needs neither SAB nor isolation) runs.
Counterintuitively, **adding** COOP/COEP (the usual "fix" for OPFS) is what _caused_ the
deadlock here. Concretely:

- `src/worker.ts` — return the SSR response unmodified (no COOP/COEP).
- removed `public/_headers` and `vite.config.ts` `preview.headers`.
- `vite.config.ts` — `sqlocal({ coi: false })` so dev matches prod (no SAB anywhere).
- kept `patches/sqlocal@0.18.0.patch` (switches SQLocal to `installOpfsSAHPoolVfs` /
  `OpfsSAHPoolDb`).

After the fix, a fresh deployed stream page shows `Events: 2`, `Storage: opfs`,
`DB file size: 32 KB`, `crossOriginIsolated: false`, with 2 event rows rendered.
**Note:** verify in a _fresh_ browser profile — a profile that previously loaded the COI
build reports stale `crossOriginIsolated: true` from cache and re-freezes.

Hypotheses ruled out before finding the real cause (all on the production build):

| Hypothesis                 | Verdict | Evidence                                                                                               |
| -------------------------- | ------- | ------------------------------------------------------------------------------------------------------ |
| Missing / 404 assets       | ✗       | `sqlite3-*.wasm`, `sqlite3-opfs-async-proxy-*.js`, `sqlite3-worker1-*.js` all emitted + served `200`   |
| Wrong MIME                 | ✗       | wasm `application/wasm`, proxy/worker `text/javascript`                                                |
| Asset COEP/CORP missing    | ✗       | added via `public/_headers`; still froze                                                               |
| `opfs-sahpool` VFS itself  | ✗       | patch alone (with COI still on) still froze — the async-proxy auto-install during init deadlocks first |
| Minifier mangling the glue | ✗       | `build.minify:false` build still froze                                                                 |

The real differentiator was cross-origin isolation (SAB presence), not bundling/MIME/minify.
Repro of the fix: `scripts/browser-inbound-proof.sh` + a fresh-profile headless Chrome on the
deployed URL now shows `Events` growing and rows rendering.

First-party sources:

- sqlite-wasm OPFS persistence + SAH-pool VFS: <https://sqlite.org/wasm/doc/trunk/persistence.md>
- sqlite-wasm COOP/COEP requirement: <https://sqlite.org/wasm/doc/trunk/index.md>
- SQLocal (the wrapper): <https://sqlocal.dev/guide/setup>
- Cloudflare Workers static-asset response headers (`_headers`): <https://developers.cloudflare.com/workers/static-assets/headers/>
- crossOriginIsolated + COOP/COEP (MDN): <https://developer.mozilla.org/en-US/docs/Web/API/crossOriginIsolated>

# Notes

## 2026-06-03

### Refactored subscription/processor runner API toward package shape

Reworked the staging API around explicit primitives instead of `with*` wrappers:

- `StreamConnection` exposes `connection.stream` as the stream RPC surface.
- Runtime connection helpers are package-shaped under `src/browser`, `src/node`, and `src/workers`.
- `createStreamSubscription` owns the capnweb sink, queue, async iterator, `waitForEvent`, and latest `streamMaxOffset`.
- `createProcessorRunner` exposes `snapshot()`, `processEventBatch(...)`, and `run({ subscription })`; browser, Node/Vitest, and the StreamProcessorRunner Durable Object use the same downstream runner path.
- Delivery batches now call `processEventBatch({ events, streamMaxOffset })`; max-offset terminology replaced the old ambiguous stream-position wording.
- Subscription replay uses `replayAfterOffset`; omitting it live-tails, while `0` replays from the first event.
- Processor `afterAppend` remains synchronous and receives the exact stream append API plus `keepAlive(...)` and `blockProcessorUntil(...)`.

Also moved processors into `src/processors/<slug>/{contract,implementation}.ts` with filesystem-safe slugs:

- `core`
- `echo-example`
- `browser-raw-events`
- `browser-event-feed`

The browser SQLite mirror is now driven by the `browser-raw-events` processor instead of a bespoke `BrowserMirrorSink`.

Verification:

- `pnpm --filter @cf-experiments/05-stream-staging-area typecheck`
- `pnpm --filter @cf-experiments/05-stream-staging-area test`
- `pnpm --filter @cf-experiments/05-stream-staging-area build`
- deployed `stream-staging-area`
- deployed `STREAM_STAGING_E2E=true ... vitest e2e/vitest/stream-capnweb.test.ts e2e/vitest/stream-processor-node.test.ts`: `24 passed | 2 skipped`
- deployed Playwright: `21 passed`

### Fixed stale browser writer lock after deploy/schema changes

Observed a deployed-profile failure where `/streams/` showed `connected`, `follower`,
`Events: 0`, and `Storage: opfs`, while a fresh incognito profile worked. The likely cause
was a stale old tab still holding the old unversioned Web Lock (`stream-writer:/`) after a
new deployment/schema bump. A newly loaded tab could migrate/drop the shared OPFS table, then
sit forever as a follower with an empty DB because the old tab still held the writer lock and
never replayed history into the migrated table.

Changed browser writer election to include the browser DB compatibility version in the lock
name. Fresh code now takes a fresh lock such as `stream-writer:browser-db-v4:/...` and
subscribes immediately. Same-profile tabs still use the same stream `subscriptionKey`, so the
Durable Object replaces the stale browser connection and keeps one live browser subscriber.

Also hardened the wa-sqlite OPFS open path: split-view replacement exposed a transient OPFS
"file or directory could not be found" during cooperative handle handoff. The worker now
retries initial open long enough for that handoff instead of turning it into a permanent DB
error panel.

Added Playwright coverage for a fresh runtime taking over while a legacy unversioned writer
lock is deliberately held.

Follow-up: added explicit error/warning surfaces in the feed. A local SQLite query failure
now logs SQL + params to the console, local mirror write failures log and update
`connectionError`, and the feed renders a visible error banner for any stream runtime error.
The exact stuck state reported in the browser (`follower` + empty local SQLite mirror) now
renders a warning banner instead of only showing a spinner.

### Made random bulk inserts varied and filterable

The sidebar "Stream random events" tool now emits a mix of Iterate-inspired event types
(`events.iterate.com/stream/metadata-updated`, `child-stream-created`, `error-occurred`,
`events.iterate.com/circuit-breaker/configured`, `paused`, `resumed`, and
`https://events.iterate.com/manual-event-appended`) with contract-valid payloads. This
makes large-stream/filter testing less monotonous without adding a fake-data dependency.

The filter bar now shows total local events when unfiltered and `N filtered / M total` when
an event type is selected.

Verification:

- local `pnpm typecheck`
- local `pnpm test:e2e`: `21 passed`
- deployed version `2d44d39c-1f9f-4b6f-8fb1-7e6e53794ca7`
- deployed `WORKER_URL=https://stream-staging-area.iterate-dev-preview.workers.dev pnpm test:e2e`: `21 passed`

### Added an indexed browser-side event type filter

Added a minimal event-type filter above the stream feed. The stream page still keeps the
important SQL visible in the component: the count query is either `SELECT COUNT(*) FROM
events` or `... WHERE type = ?`, and the visible TanStack Virtual range query uses the
ordinary `local_index` window until a type is selected. Filtered windows walk a new SQLite
index on `(type, local_index)`, preserving stream order without adding another local
projection table.

Schema version bumped to `4`; no backwards compatibility because this is still a proof of
concept and stale browser mirrors are disposable.

Verification:

- local `pnpm typecheck`
- local `pnpm test:e2e`: `18 passed`
- deployed version `15f4eec7-9db0-483a-8d0f-c7636ffcff3e`
- deployed `WORKER_URL=https://stream-staging-area.iterate-dev-preview.workers.dev pnpm test:e2e`: `18 passed`

### Fixed stream feed scroll stutter with a TanStack Virtual repro

Built `/virtual-repro` as a small TanStack Virtual chat-list harness to isolate the stream
feed's scroll jumps from SQLite, capnweb, the composer, and the stream page chrome. The
minimal repro showed:

- A tiny/non-scrollable list (`2` rows) that receives one huge append follows the tail when
  `directDomUpdates: true` is enabled, matching the official React chat example.
- Several same-turn/microtask appends can still leave the viewport stuck far from the end.
- The same chunks spaced by `requestAnimationFrame` follow correctly.
- Normal and overlaid footer variants are not the root cause once appends are frame-spaced.

The stream page now keeps the event virtualizer close to the documented chat setup:
`anchorTo: "end"`, `followOnAppend: true`, `directDomUpdates: true`, fixed 38px collapsed
row estimates, no measured footer padding, and much less local scroll state. Pending rows are
not measured into TanStack Virtual's size cache. The browser subscriber buffers delivered
server batches into one SQLite transaction per animation frame, so the mirror still writes
large batches efficiently while the UI sees one append per paint instead of same-turn count
churn.

Verification:

- local `pnpm --filter @cf-experiments/05-stream-staging-area test:e2e`: `13 passed`
- deployed version `5c0f6e53-b250-423d-a0f5-8ed4b51e7cd9`
- deployed `WORKER_URL=https://stream-staging-area.iterate-dev-preview.workers.dev pnpm --filter @cf-experiments/05-stream-staging-area test:e2e`: `13 passed`

Follow-up: the composer now lives inside the native stream scroller but uses `position:
sticky; bottom: 0`, so the scrollbar still runs to the bottom of the viewport beside the
composer while the composer stays visible when scrolling up from a long stream. The
Playwright suite now asserts this directly by scrolling upward from the tail and checking the
composer remains pinned to the scroller bottom.

Follow-up: restored the bottom affordance unread badge. `EventRows` tracks only local view
state: when `eventCount` increases while TanStack Virtual says the view is not at the end, it
adds that delta to the badge; reaching or clicking the tail clears it. Added Playwright
coverage for the simple one-event case and a stress case: seed 100 rows, scroll away from the
tail, append 5,000 rows over 5 seconds while jitter-scrolling older rows without entering the
end threshold, and assert the affordance ends at `5,000 new events`.

Verification:

- local `pnpm typecheck`
- local `pnpm test:e2e`: `16 passed`
- deployed version `352e53eb-831f-437f-9549-41ee5a61c59b`
- deployed `WORKER_URL=https://stream-staging-area.iterate-dev-preview.workers.dev pnpm test:e2e`: `14 passed`

### Simplified the browser stream mirror around raw SQLite queries

Reworked the stream page/browser mirror after reviewing primary docs for React external
stores, TanStack Virtual, SQLite JSON/JSONB, wa-sqlite OPFSCoopSyncVFS, and TanStack Start
routing. The browser now has a component-owned stream runtime: each mounted stream view owns
its capnweb client, Web Locks leadership election, wa-sqlite worker connection, and blunt
SQLite-query invalidation. There is no global per-stream runtime singleton and no local
browser processor layer.

The local browser DB is now one raw-events table. It stores the payload once as SQLite JSONB
(`raw_jsonb`), derives `offset`, `type`, `idempotency_key`, and `created_at` as generated
columns, and records `inserted_at` when the browser first stores the row. `local_index` is
the ordinary zero-based primary key for TanStack Virtual. Today `local_index = offset - 1`;
SQLite rejects gaps, rejects conflicting duplicate offsets, and ignores identical replay so
`inserted_at` is stable. The stream page intentionally shows the two key SQL reads in code:
`SELECT COUNT(*) AS count FROM events` and the visible `local_index` range query.

Added `/split-stream?left=...&right=...` with two compact stream views that use the same
stream/composer components. Mounting the same stream twice in one tab verifies the same
leadership-election path as multiple tabs: one runtime subscribes/writes and the other
follows the shared OPFS mirror.

Added Playwright browser tests with `WORKER_URL` support. Without `WORKER_URL`, Playwright
starts local Miniflare via `pnpm dev --host 127.0.0.1`; with `WORKER_URL`, the same tests run
against a deployed worker.

Expanded the suite to cover:

- append + browser mirror update;
- split view of the same stream;
- split view of two different streams;
- split view disposal/handoff when one same-stream pane is replaced with another stream;
- multi-tab realtime update and writer handoff after the leader tab closes;
- a 1500-event stream with TanStack Virtual bounded DOM rows and top/bottom scrolling;
- raw SQLite download into a temporary folder, queried with `sqlite3`;
- kill/reconnect (`woken` event appended);
- reset plus stale-local-mirror discard.

The deployed reset test exposed a real production-only race: `reset()` originally fired
`ctx.storage.deleteAll()` and immediately called `ctx.abort()`. Miniflare behaved as if the
delete completed; deployed Cloudflare preserved the old rows and appended offset 4. Fix:
`await this.ctx.storage.deleteAll(); await this.ctx.storage.sync(); this.kill();`. This
matches Cloudflare's storage docs: `deleteAll()` removes the SQLite-backed DO database, and
`sync()` resolves once previous writes have been persisted before external effects proceed.

Verification:

- `pnpm --filter @cf-experiments/05-stream-staging-area typecheck`
- `pnpm --filter @cf-experiments/05-stream-staging-area test`
- `pnpm --filter @cf-experiments/05-stream-staging-area test:e2e`
- `pnpm --filter @cf-experiments/05-stream-staging-area build`
- `WORKER_URL=https://stream-staging-area.iterate-dev-preview.workers.dev pnpm --filter @cf-experiments/05-stream-staging-area test:e2e` — 9/9 passed after deploy version `13ec62f6-71d9-4695-81e2-1017f7515f80`.
- `pnpm --filter @cf-experiments/05-stream-staging-area exec -- npx react-doctor@latest --verbose --diff` — 98/100 ("Great"). Remaining warnings are an editable path draft initialized from route props and a false-positive `navigate()`-in-render warning for an event handler.

First-party sources:

- React `useSyncExternalStore`: <https://react.dev/reference/react/useSyncExternalStore>
- TanStack Virtual: <https://tanstack.com/virtual/latest/docs/api/virtualizer>
- Playwright `webServer` / `baseURL`: <https://playwright.dev/docs/test-webserver>
- SQLite JSONB: <https://www.sqlite.org/json1.html>
- Cloudflare Durable Object storage `deleteAll()` / `sync()`: <https://developers.cloudflare.com/durable-objects/api/storage-api/>

### Two more browser non-linearities (both size-dependent → now constant)

1. **"kill stream" → slow `woken` on large streams.** On reconnect the browser re-subscribed
   at `replayAfterOffset = -1` (the runner's no-op storage had no cursor), so the Stream DO replayed
   the WHOLE stream before the newly-appended `woken` arrived — delay grew with stream size.
   Fix: the runner's `storage.load` now returns the local SQLite mirror's `maxOffset()` as the
   resume cursor (the events table IS the durable cursor), with a fallback to `-1` if the DB
   read fails. Verified on deployed: kill on a 3002-event stream → only **1** event replayed
   (`recvDelta=1`), constant regardless of size.
2. **Flicker on every append in a long list.** The windowed row query sized itself to the live
   last index (`max(lastIndex, …)`), so every append re-keyed the query; a fresh reactive query
   starts empty, blanking the visible window for a frame. Fix: a FIXED-size, bin-aligned window
   (key changes only once per ~1000 rows of scrolling) + a bounded retained-rows cache so the
   occasional window shift repaints from cache instead of blanking. Verified on deployed: 60
   rapid samples while appending near the tail of a 1200+ event stream → `minRendered=11`,
   `maxPending=0` (never blanks). Both provisional (not yet repeated across sessions).

### Perf: `PRAGMA busy_timeout` causes a ~5s first-open stall with OPFSCoopSyncVFS

First page load sat on "opening sqlite DB" for ~5s (independent of event count). Cause:
OPFSCoopSyncVFS acquires its OPFS `FileSystemSyncAccessHandle` **asynchronously** — its
`jLock` returns `SQLITE_BUSY` and pushes the acquisition onto wa-sqlite's `Module.retryOps`,
which `sqlite3.exec`/`statements` `await` and then retry (resolves in ~one event-loop turn).
Setting `PRAGMA busy_timeout = 5000` **breaks this**: SQLite's core busy handler retries
_synchronously_, blocking the event loop so the async acquisition can never resolve, and it
spins for the entire timeout before yielding to wa-sqlite's `retry()`. Measured init on a
fresh stream: **5081ms → 64ms** after removing the pragma (`wasm 7 / vfs.create 9 / open 4 /
schema 10`). Genuine cross-connection (multi-tab) contention is handled instead by a bounded
JS-layer retry-on-`SQLITE_BUSY` with backoff (`withBusyRetry` in `stream-db.worker.ts`).

Confirmed on the production build: reopening an 808 KB DB (3002 events) → 137ms init, ~253ms
to first rendered rows; deployed cold load → ~1.2s to first render (dominated by page/JS/wasm
download + the capnweb subscribe round-trip, not SQLite). Init is size-independent — the
count is special-cased (O(1)) and the row query is LIMIT-windowed — so thousands of events
load just as fast. NOT yet repeated across sessions — provisional.

### Migrated the browser SQLite mirror from SQLocal → wa-sqlite OPFSCoopSyncVFS

Replaced SQLocal/`@sqlite.org/sqlite-wasm` (opfs-sahpool, kept working only by removing
cross-origin isolation) with **wa-sqlite's `OPFSCoopSyncVFS`** (the `@journeyapps/wa-sqlite`
fork). Why: opfs-sahpool is **single-connection** — only one tab can open the DB — so
multi-tab reactive reads were impossible. OPFSCoopSyncVFS allows **multiple cooperative
per-tab connections** against one OPFS file, needs **no SharedArrayBuffer, no async-proxy
worker, and no COOP/COEP**, and is the VFS PowerSync recommends as the cross-browser
default (Chrome / Edge / Safari 16.4+ / mobile Safari 16.4+).

Architecture (all in `src/client-libraries/`):

- `stream-db.worker.ts` — per-tab dedicated worker owning one wa-sqlite connection; generic
  `exec`/`batch`/`export`. `FileSystemSyncAccessHandle` only exists in a dedicated worker
  (never main thread / SharedWorker), hence one worker per tab.
- `stream-leader.ts` — single-writer election via the **Web Locks API**. The lock holder is
  the writer (subscribes + writes); it auto-releases on tab close for seamless failover.
- `stream-browser-db.ts` — worker client + an **offset-range-aware reactive query layer**:
  a query declares the offset range its result depends on; an append announces the range it
  wrote; only intersecting queries re-run. A fixed historical window is immutable under
  append-only and never re-runs. The **event count is special-cased** — advanced straight
  from the writer's cross-tab change broadcast (O(1), zero per-append SQL), since the row
  count is all TanStack Virtual needs. Cross-tab freshness rides a `BroadcastChannel`.
- `use-stream-query.ts` — React 19 `useSyncExternalStore` hooks (cached stable snapshot;
  async re-run triggered in `subscribe`). Not `use()`+Suspense: React docs warn against
  suspending on a useSyncExternalStore value. oxlint `--deny-warnings` clean.
- Added a `processor_state(processor_slug, state)` table mirroring the Stream DO's, so the
  browser can host multiple reducing processors next (same SQLite snapshot shape per runtime).

Verified on the **production build** (`vite preview`) AND **deployed Cloudflare**, headless
Chrome for Testing: events render and update live; a **second tab that never subscribed
(`__receivedEventCount === 0`)** reflects the writer's appends reactively via the shared OPFS
file; 24/24 e2e pass. Multi-tab quirk worth noting: the first cross-tab propagation after an
append can lag a few seconds while OPFSCoopSyncVFS hands the single `SyncAccessHandle` between
the two connections (covered by `PRAGMA busy_timeout`); it then converges. NOT yet repeated
across sessions — provisional.

First-party sources:

- PowerSync, "Current State of SQLite Persistence on the Web" (May 2026): <https://powersync.com/blog/sqlite-persistence-on-the-web>
- wa-sqlite (`OPFSCoopSyncVFS`): <https://github.com/rhashimoto/wa-sqlite> ; PowerSync fork: `@journeyapps/wa-sqlite`
- React `useSyncExternalStore`: <https://react.dev/reference/react/useSyncExternalStore>
- Web Locks API (MDN): <https://developer.mozilla.org/en-US/docs/Web/API/Web_Locks_API>
- OPFS `createSyncAccessHandle` (MDN): <https://developer.mozilla.org/en-US/docs/Web/API/FileSystemFileHandle/createSyncAccessHandle>

## 2026-06-02

### ~17:00 — Restructured Stream subscription/delivery machinery

Collapsed the six tangled subscription methods in `src/stream.ts`
(`#subscribe`, `#catchUpSubscription`, `#deliverToLiveSubscriptions`, `#deliverBatch`,
`#closeSubscription`, `#reconcileOutboundSubscriptions`) into three
(`#openConnection`, `#reconcile`, `#reconcileOutboundConnections`).

Why it was woozy: the code had grown a `phase: "catching-up" | "live"` state machine
that `design.md` explicitly resolved against ("the runner IS the sink … no
catch-up-vs-live split"). Two delivery paths existed, but live delivery was silently
disabled during catch-up (`if phase !== "live" continue`), so correctness rode entirely
on the catch-up loop re-reading storage. `lastDeliveredOffset` had three writers (one
dead). `appendBatch` fused the atomic commit with both sync delivery and async reconcile.
Reconcile ran on _every_ append.

New shape: a connection is a single cursor-driven pump — `getEvents(afterOffset: cursor)`
in a loop until storage is exhausted, then park. Replay and live are the same code path.
`appendBatch` no longer delivers; it calls `connection.wake()`. A `draining` boolean makes
`wake()` idempotent and closes the delivery race (commit happens before `wake()`, so an
in-flight pump's next read always sees the new rows → exactly-once, no drop/double).

Bugs fixed as a side effect:

- **Hibernation gap**: nothing re-established _outbound_ connections after a restart
  unless a new append happened to fire reconcile. Constructor now calls `#reconcile()`.
- **Duplicate-dial race**: a `#connecting` Set reserves the key before the
  `await processor.fetch(...)`, so concurrent reconciles can't open two websockets.
- Reconcile moved off the per-append path → runs on boot, on `subscription-configured`
  appends, and on outbound connection loss only.

Consumers updated (no backcompat kept): `runtimeState().runtime.liveSubscriptions` →
`connections` (reshaped); removed dead `Subscription`/`Offset` types from
`stream-types.ts` (folded `Offset` into `StreamCursor`).

Known trade-off + future optimization documented inline in `#openConnection`: the live
path pays one indexed `getEvents` read per batch even when the subscriber is caught up.
Proposal B fast path (hand the in-memory append array straight to the sink when
`cursor === firstNewOffset - 1`) is left as a documented TODO, gated on a benchmark.

Verification:

- `pnpm typecheck`: clean
- `pnpm test`: `10 passed | 9 skipped` (unit)
- `STREAM_STAGING_E2E=true WORKER_URL=http://localhost:5173 pnpm test`: `19 passed`
  — includes the inbound replay→live test and the built-in outbound processor test,
  which exercise the rewritten pump + reconciler end to end.

### Earlier

Added `src/client-libraries/stream-browser.ts` as the first dedicated browser stream client
library. CapnWeb's `newWebSocketRpcSession()` returns synchronously and queues sends while the
browser WebSocket is connecting, so the preferred browser shape is `using stream = withStream({
url })`; `await using stream = await withStream({ url })` also works.

Changed the TanStack Start app into a stream viewer. `/` redirects to `/streams/`, `/streams/`
subscribes to the root stream, and `/streams/*` maps to stream paths under `/`. The old runtime
client helpers moved out of `src/client.ts` because TanStack Start uses that file as its browser
hydration entrypoint.

Verified locally that `/` redirects to `/streams/`, `/streams/` renders the root stream events,
and editing the path to `/anything/else` navigates to `/streams/anything/else` with a new
subscription.

Created `stream-staging-area` as the CapnWeb-only staging version of the handwritten stream
experiment.

Converted the worker entrypoint into a minimal TanStack Start React app using Vite and the
Cloudflare Vite plugin. The same worker still dispatches `/api/streams/*` and
`/stream-processor-runner/*` to the stream Durable Objects before falling back to the React app.

Verification:

- local `vite dev` root page returned `200 OK`
- local `STREAM_STAGING_E2E=true WORKER_URL=http://localhost:5173 ... stream-capnweb.test.ts`:
  `7 passed`
- deployed `https://stream-staging-area.iterate-dev-preview.workers.dev/` returned `200 OK`
- deployed `STREAM_STAGING_E2E=true WORKER_URL=https://stream-staging-area.iterate-dev-preview.workers.dev ... stream-capnweb.test.ts`:
  `7 passed`
