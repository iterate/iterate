# Collapsing the browser stream mirror into itx live-state

The design for retiring the browser-hosted stream database/processor host so a
stream feed is just `useLiveState` + `useItxQuery` like every other screen.
Reviewed against the code 2026-07-16; companion to
[`docs/frontend-development.md`](../../../docs/frontend-development.md) (which
documents the seam) and the
[roadmap](itx-frontend-model-roadmap.md) (which sequences it).

## The problem

The browser consumes streams via two models:

- **Model 1 (itx-native, thin):** `useLiveState((itx) => itx.liveState, sel)` —
  the server owns a reduced view and pushes snapshot + diffs. The ⌘K stream
  switcher and the stream tree use it.
- **Model 2 (the mirror, heavy):** `useStreamMirror()` + `useStreamQuery(db,
sql)` — download the whole event log once per `(projectId, streamPath)` and run
  two processors client-side into an OPFS SQLite database, with cross-tab
  Web-Locks leader election, two-cursor durable checkpoints, a transactional
  write buffer, and a self-healing connection state machine. **~4,850 LOC**:
  `client-libraries/browser/` (~4,140) + the two canonical processors (~706).

The seam: the mirror bypasses the itx hooks. `ProjectStreamView`
(`apps/os/src/components/project-stream-view.tsx:133-182`) builds a
`createStreamClient` factory that imperatively dials
`connectItx()`/`connectIterateSession()` and hands the stub to
`acquireStreamRuntime`, which drives its own subscribe/leader/processor/
checkpoint stack. PR #2048 unified the **socket** (the mirror rides the shared
session and only _reports_ transport suspicion) but not the **consumption
model**.

**The core realization: the two processors collapse asymmetrically.**

- The raw `events` log is immutable/historical/paged → maps onto `useItxQuery`
  over the **already-existing** `Stream.getEvents` pager (server clamp 1–500,
  `stream-durable-object.ts`; `getEvent({ offset })` also exists). Low risk,
  **no server work**.
- The `feed_items` projection + `AgentUiState` live tail is a reduced view →
  maps onto `.liveState`, but the fold that produces it
  (`packages/ui/.../agent-ui-reducer.ts`, ~1,064 LOC, + the browser-feed
  `projector.ts`, ~243 LOC) runs **only in the browser** today. The server-side
  replacement is net-new materialized-view work in the stream DO. **That is the
  long pole.**

## What the two browser processors produce, and who reads it

**Raw-events processor** (`processors/browser-raw-events/implementation.ts`):

- `events` — the verbatim wire log (`raw_jsonb` source of truth; offset/type/
  idempotency-key as generated columns; a `BEFORE INSERT` trigger enforces
  idempotent replay + monotonic offsets). Offsets are dense:
  `local_index = offset − 1`, so an offset IS a position.
- `event_type_counts` — trigger-maintained per-type counts (avoids `COUNT(*)`
  full scans; ~1M rows ≈ 12s tail lag otherwise).
- Readers: the raw-event inspector (point + prev/next by offset), the LLM
  request inspector (events ≤ `llmRequestOffset` + that request's
  `llm-response-chunk`s, reconstructed by `llm-request-replay.ts`), the
  pause-state read, and the header/filter counts.

**Feed processor** (`processors/browser-feed/implementation.ts`):

- `feed_items` — one row per rendered feed item (`local_index` PK; pretty and
  raw interleaved in one total order; `kind` = `agent.<itemKind>` |
  `raw.group` | `raw.<component>`).
- Persisted **`AgentUiState`** reduced state — the live tail: `{ live,
queuedUserMessages, eventCount, presence, tokenUsage }`.
- Readers: `StreamFeedView` (one virtualized `ORDER BY local_index` list; every
  mode is a filter over it), `ProjectStreamView` (busy/presence/running-LLM/
  token-usage/queued), the trailing `AgentLiveActivity`.

The runtime itself also serves: `appendBatch` (the composer's target),
`noteExternalAppend`, `runtimeState`, `metrics`, `nudge`, `clearLocalDatabase`.

## The server-side replacement

### `itx.streams.get(path).liveState` — the bounded feed live view

A new **server-hosted feed processor** in the stream DO folds the same two
lenses and exposes:

```ts
type StreamFeedLiveState = {
  agent: AgentUiState; // live tail, queued, presence, token usage — verbatim reducer output
  recentItems: FeedItem[]; // a BOUNDED window of the newest settled feed items
  tailLocalIndex: number; // highest allocated local_index (feed length; also the event total)
  paused: { paused: boolean; reason: string | null };
};
```

The plumbing pattern already exists — the repo DO's `get liveState()`
(`repo-durable-object.ts`), `LiveStateRelayRpcTarget` (`rpc-targets.ts`), and
the project DO's registry `getLiveState` wiring
(`project-durable-object.ts:86-108`). What's missing is only the feed processor
itself. Consumed as `useLiveState((itx) => itx.streams.get(path).liveState,
sel)`.

### Paged history — mostly already exists

- **Raw events:** `getEvents({ beforeOffset | afterOffset, limit })` paged
  reads under `useItxQuery`; adjacency via `limit: 1`; totals from
  `tailLocalIndex` (offsets dense). **No new server capability.**
- **Feed history:** one new server verb, `getFeedItems({ beforeLocalIndex,
limit })`, reading the feed processor's own settled rows — recommended, so the
  client never re-runs the projector for history (otherwise we re-import the
  fold we're deleting).

### Why the live view must be bounded

The live-state engine snapshots the whole state to each new subscriber and
re-broadcasts on change — an unbounded array can't ride it. So the live view
carries a bounded recent window and older history is a paged read, stitched in
the UI. That is the correct shape, not a compromise: history is immutable, and
immutable data is a finite read (the frontend guide's first rule of thumb).

## What the feed view becomes

`ProjectStreamView` keeps its shell, URL state, composer, header, and panels;
only the data plumbing changes:

- **One `useLiveState` subscription** replaces `useAgentUiReducedState` (→
  `feed.agent`), the counts (→ `tailLocalIndex`), and the pause read (→
  `feed.paused`).
- **Paged `useItxQuery`** over `getFeedItems`/`getEvents` replaces
  `useStreamQuery(db, sql)` in the feed and both inspectors.
- **Mutations become direct capability calls** (`append` on the stream / the
  agent chat door); `noteExternalAppend`/`nudge` disappear — the subscription's
  next push is the confirmation, and `useItxSubscription`'s watchdog already
  owns silent-death recovery.
- `StreamFeedView` keeps the virtualizer, stick-to-bottom, retention
  (`useRetainedFeedRows`) machinery verbatim — the row _source_ changes from a
  SQL handle to live-window ⊕ paged rows in the same retained map.

## What gets deleted (~4,850 LOC)

Once nothing reads the mirrored database: `stream-browser-store.ts` (2,215),
`stream-browser-db.ts` (520) + `stream-db.worker.ts` (212) +
`stream-database-registry.ts` (31) + `wa-sqlite.d.ts` (11),
`processor-state-storage.ts` (403) + `projection-write-buffer.ts` (123),
`composite-mirror-drive.ts` (182), `stream-leader.ts` (101),
`canonical-mirror-processors.ts` (65), `catch-up-page.ts`,
`core-processor-state.ts`, `ensure-schema-once.ts`, `stream-runtime-utils.ts`,
`stream-transport.ts`, `hooks/use-stream-mirror.ts`, `hooks/use-stream-query.ts`;
`processors/browser-feed/` + `processors/browser-raw-events/`; and the consumer
plumbing (`useAgentUiReducedState`, `useStreamPauseState`,
`clearClientDatabases`, the `streamClientFactory`/`resetTransport` wiring, all
`store`/`database` props).

**Not deleted, moved:** the `agent-ui-reducer` + projector fold relocate into
the server feed processor. They are pure functions with no React dependency —
a packaging concern, not a rewrite.

## What we lose (honest)

- **Cross-tab single-download** (Web-Locks leader). Matters little: N tabs cost
  N cheap bounded subscriptions, and the fold is shared by ALL tabs everywhere
  (it runs once, in the DO) — better in aggregate.
- **Cold-reload instant paint from OPFS.** The main honest regression, and it's
  minor: first paint becomes one round trip, like every other itx surface.
  `useLiveState` already keeps its last value across transport gaps.
- **Local scroll latency into uncached history.** Mitigated: the bounded live
  window covers the tail (the common case), `useItxQuery` caches pages, and the
  feed's skeleton machinery already tolerates async rows. Deep back-scroll on a
  1M-event stream is slightly less instant — a fair trade for ~4,850 LOC.
- **Event scrubbing round-trips.** Fully mitigable — identical behavior at one
  RTT per navigation via `getEvent`/`getEvents`.
- **`event_type_counts`.** Free to replace: totals from `tailLocalIndex`;
  per-type filter counts (if still wanted) become a server aggregate.
- **Measured browser RTT metrics.** Re-source from `stream.runtimeState()`; the
  consume-own-append metric existed to debug the mirror being deleted.

## Phasing + risks

Incremental, **not** a flag-day — the mirror is acquired per-view and
refcounted; keep it until the last reader migrates.

- **Phase A — raw events → `useItxQuery`** (low risk, no server work). Rewire
  the two inspectors + pause state + counts onto `getEvent`/`getEvents` +
  `tailLocalIndex`. Verify against `stream-resume-after-suspend` + inspector
  e2es.
- **Phase B — the server feed processor + `.liveState`** (the long pole; all
  the risk). Move the reducer + projector fold into a stream-DO-hosted
  processor; expose `StreamFeedLiveState` via the existing LiveState relay
  pattern; add `getFeedItems`. A new load-bearing materialized view: its
  init/persist/rebuild/version-skew/cold-DO behavior must be explicit and
  tested; idempotent on replay; it rides the runner's durable checkpoints (not
  a hand-rolled cursor store). Watch DO CPU/storage on the hot append path;
  keep settled rows in the DO's SQLite.
- **Phase C — migrate the feed UI per surface** behind the existing mode/URL
  machinery (main feed → agent chat → raw browser); composer to direct
  `append`. The subtle UI risk is the bounded-window ⊕ paged-history stitching
  seam — the virtualizer's end-anchor/retention was tuned for one dense SQL
  table (`stream-feed-view.tsx` documents the failure modes); reuse the
  retained-rows map and the skeleton-measures invariant.
- **Phase D — delete** `client-libraries/browser/` + both canonical
  processors.

**Irreducible client-side:** the virtualizer/stick-to-bottom/retention
machinery (pure UI, stays), and paged-not-live history (the correct shape).
Everything else in Model 2 — OPFS, leader election, checkpoints, write buffer,
composite drive, the connection state machine — is replaceable and should go.

## Critical files

- `apps/os/src/components/project-stream-view.tsx` (`:133-231` is the seam)
- `apps/os/src/rpc-targets.ts` (`StreamRpcTarget`; copy the repo `liveState`
  getter + relay pattern)
- `apps/os/src/domains/streams/stream-durable-object.ts` (host the feed
  processor, mirroring `project-durable-object.ts:86-108`)
- `packages/ui/src/components/events/agent-ui-reducer.ts` +
  `apps/os/src/domains/streams/client-libraries/processors/browser-feed/projector.ts`
  (the fold that moves server-side)
- `apps/os/src/components/stream-feed-view.tsx` (the row-source rewire)
