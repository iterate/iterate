# Stream Browser Storage Review

## Scope

Reviewed `src/routes/-stream-page.tsx`, the browser stream storage modules it depends on, and the experiment instructions in `../../../README.md` and `README.md`.

Update after implementation: the final patch follows this report's simplification direction,
but uses SQLite JSONB (`raw_jsonb`) plus generated scalar columns instead of the early
`raw_json TEXT` sketch below. It also keeps `local_index` as the zero-based TanStack Virtual
position and makes SQLite reject offset gaps.

Primary sources consulted:

- React `useSyncExternalStore`, render purity, refs, `useMemo`, and `useLayoutEffect`: https://react.dev/reference/react/useSyncExternalStore, https://react.dev/reference/rules/components-and-hooks-must-be-pure, https://react.dev/learn/referencing-values-with-refs, https://react.dev/reference/react/useMemo, https://react.dev/reference/react/useLayoutEffect
- TanStack Start client-only execution: https://tanstack.com/start/latest/docs/framework/react/guide/execution-model
- TanStack Virtual API/chat guidance: https://tanstack.com/virtual/latest/docs/api/virtualizer
- Web Locks and BroadcastChannel: https://developer.mozilla.org/en-US/docs/Web/API/Web_Locks_API, https://w3c.github.io/web-locks/, https://developer.mozilla.org/en-US/docs/Web/API/Broadcast_Channel_API
- OPFS and storage quota: https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system, https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria
- wa-sqlite OPFS VFS docs/source: https://github.com/rhashimoto/wa-sqlite/blob/master/README.md, https://raw.githubusercontent.com/rhashimoto/wa-sqlite/master/src/examples/README.md
- SQLite rowid and transactions: https://www.sqlite.org/rowidtable.html, https://www.sqlite.org/lang_transaction.html, https://www.sqlite.org/queryplanner.html

## High-Level Read

The platform primitives are mostly right:

- Web Locks is the correct primitive for electing exactly one active subscriber tab.
- `OPFSCoopSyncVFS` is a defensible wa-sqlite choice for multi-tab OPFS without COOP/COEP.
- A dedicated worker for SQLite/OPFS is right; OPFS synchronous file access belongs off the main thread.
- `useSyncExternalStore` is a reasonable React primitive for browser-owned external state.
- TanStack Virtual is the right rendering primitive for enormous append-only lists.

The problem is not the primitives. The problem is that a simple append-only SQLite mirror has grown into a bespoke storage framework: query scopes, trigger-maintained metadata, manual row-window caches, cross-tab count messages, write-mode policy, and virtualizer-tail policy are all entangled. That makes the code harder to trust than the workload requires.

Your stated preference should become the north star: keep the schema basic, keep SQL visible in code where possible, and avoid hiding ordinary SQLite queries behind layers of cruft.

## Recommended Direction

Use a minimal append-only schema:

```sql
CREATE TABLE IF NOT EXISTS events (
  offset INTEGER PRIMARY KEY,
  type TEXT NOT NULL,
  idempotency_key TEXT,
  created_at TEXT NOT NULL,
  raw_json TEXT NOT NULL
);
```

If stream offsets are not dense enough to drive TanStack Virtual indexes directly, add one local index and nothing else:

```sql
CREATE TABLE IF NOT EXISTS events (
  local_index INTEGER PRIMARY KEY,
  offset INTEGER NOT NULL UNIQUE,
  type TEXT NOT NULL,
  idempotency_key TEXT,
  created_at TEXT NOT NULL,
  raw_json TEXT NOT NULL
);
```

Then delete `stream_meta`, delete the insert/delete triggers, delete `StreamQueryScope`, and make BroadcastChannel a wake-up signal rather than an authoritative source of row count. The route can run visible SQL like:

```ts
useSqliteQuery(db, {
  sql: `SELECT COUNT(*) AS count FROM events`,
  invalidates: "tail",
});

useSqliteQuery(db, {
  sql: `SELECT offset, type, idempotency_key, created_at, raw_json
        FROM events
        ORDER BY offset ASC
        LIMIT ? OFFSET ?`,
  params: [limit, offset],
  invalidates: "tail",
});
```

The hook can still use `useSyncExternalStore`, but it should be boring: cache the last snapshot, rerun on local writes or BroadcastChannel, and keep SQL text visible at the call site. Do not make the hook encode stream-specific ideas like immutable ranges, tail windows, or virtualizer bins.

## Findings

### 1. Cross-tab clear can show stale cached rows

`EventRows` remounts on `snapshot.clearVersion` in `src/routes/-stream-page.tsx:167`, but that snapshot is only incremented by the tab calling `clearLocalDatabase()`. Other tabs receive the DB-level clear broadcast, but `EventRowWindow` retains `rowCacheRef` until the component remounts at `src/routes/-stream-page.tsx:556`.

Options:

- Delete the row cache and render only the current query snapshot.
- Move stale-data retention into the SQLite query hook and clear it on DB clear.
- Broadcast a clear version from the DB and subscribe the page to that directly.

Recommendation: delete the page-owned row cache as part of the simpler SQL/windowing rewrite.

### 2. Worker DB requests are not serialized

`stream-db.worker.ts:124` starts each request independently. A clear, compact, export, insert batch, or query can overlap with another operation. `clearPendingWrites()` only drops queued events; it cannot cancel an insert already inside `insertEventBatch()`.

Options:

- Add a promise queue in the worker and process one message at a time.
- Move sequencing to `StreamBrowserDatabase.#call`.
- Use per-operation locks in the main thread.

Recommendation: add a tiny worker-side queue. SQLite has one connection in the worker; the code should reflect that explicitly.

### 3. The schema is overdesigned

`stream-browser-db.ts:142` creates `virtual_index`, `offset UNIQUE`, `stream_meta`, `processor_state`, and triggers. For the browser viewer, this is too much. SQLite already gives cheap rowid/`INTEGER PRIMARY KEY` access, and ordinary `COUNT(*)`, `MAX(offset)`, and `LIMIT/OFFSET` queries are clearer than maintaining a second metadata table for the UI.

Options:

- Use `offset INTEGER PRIMARY KEY` if offsets are dense.
- Use `local_index INTEGER PRIMARY KEY` plus `offset UNIQUE` if offsets may have gaps.
- Keep `processor_state` only if a browser processor experiment actively uses it.

Recommendation: choose the simplest schema that matches offset density. Keep every query visible and local.

### 4. BroadcastChannel is treated as authoritative state

`StreamDbChange.eventCount` drives the in-memory count directly in `stream-browser-db.ts:452`. BroadcastChannel messages are useful invalidation, but correctness should come from SQLite. Messages can be missed by tabs that are not connected yet.

Options:

- Broadcast only `{ kind: "changed" }` or `{ kind: "clear" }` and rerun visible SQL.
- Keep event count in the message as an optimization, but always reconcile from SQLite on startup/focus/clear.
- Keep current behavior.

Recommendation: use BroadcastChannel only to wake queries. Trust the DB.

### 5. Changing SQLite write mode recreates the stream store

`HydratedStreamPage` keys `createStreamBrowserStore()` on `[sqliteWriteMode, streamPath]` at `src/routes/-stream-page.tsx:35`. Toggling a write-mode select tears down subscription/election/socket state.

Options:

- Remove the row-vs-batch write-mode UI entirely.
- Keep one store per `streamPath` and call `streamDatabase.setWriteMode()`.
- Expose `streamStore.setWriteMode()`.

Recommendation: remove row mode unless it is still being measured. If retained, make it a mutable DB setting, not a store identity.

### 6. Store and database lifetimes leak browser resources

`getStreamBrowserDatabase()` stores one permanent DB instance per stream path. Each instance owns a Worker and BroadcastChannel. Navigating through many paths leaves those resources alive for the session.

Options:

- Add explicit `dispose()` to terminate the worker and close BroadcastChannel.
- Reference-count DB instances by mounted stream page.
- Keep one global DB only for the current stream.

Recommendation: add a simple dispose/ref-count path, or remove the per-path singleton and let the page own one DB runtime.

### 7. Virtualizer tail-follow logic is duplicated

`useVirtualizer()` uses `anchorTo: "end"` and `followOnAppend: "smooth"` at `src/routes/-stream-page.tsx:380`, then a layout effect manually calls `scrollToEnd()` on append at `src/routes/-stream-page.tsx:397`.

Options:

- Let TanStack Virtual handle end anchoring and follow-on-append; keep only the explicit jump button.
- Remove `followOnAppend` and keep fully manual follow state.
- Keep both.

Recommendation: use TanStack Virtual's built-in append-follow behavior and delete the manual append-scroll effect unless a measured bug requires it.

### 8. `EventRowWindow` mutates render-affecting refs during render

`src/routes/-stream-page.tsx:581` writes query rows into `rowCacheRef.current` during render, and the rendered rows depend on that mutated ref. React's purity rules say render should not perform side effects, and refs should not be read/written during render when they affect output.

Options:

- Delete the cache.
- Move cache mutation into an effect and accept one render of stale data.
- Move retained-data behavior into the query hook snapshot.

Recommendation: delete the page-owned cache. If stale data is needed during page shifts, make it part of the hook result.

### 9. `clearLocalDatabase()` can race reconnect

`clearLocalDatabase()` disposes the stream while `disposed` is false, then clears/compacts, then reconnects. The close handler can call `reconnectAfter()` during that clear window.

Options:

- Add a `clearing` flag that suppresses reconnect timers until clear/compact is complete.
- Serialize store operations through one async queue.
- Avoid disconnecting at all; pause leadership, clear, then reconnect once.

Recommendation: add an explicit store operation queue or `clearing` state. This is a correctness issue independent of the bigger simplification.

### 10. Web Locks errors are ignored

`stream-leader.ts:26` assumes `navigator.locks` exists and ignores rejection from `navigator.locks.request()`. If unavailable or rejected, `whenWriter` never resolves.

Options:

- Throw a clear capability error if `navigator.locks` is missing.
- Add a fallback single-tab mode for development.
- Surface failed election in the snapshot.

Recommendation: surface a clear error. This experiment depends on Web Locks for correctness.

### 11. The page component is carrying too many policies

`-stream-page.tsx` mixes route chrome, connection controls, DB actions, insert test tooling, virtualizer policy, query window policy, and row cache policy. The most important thing is not at the top.

Options:

- Collapse thin wrapper components, but extract browser runtime/query policy out of the page.
- Keep the page as the place where SQL is visible, but move lifecycle/election/worker plumbing to a hook.
- Split UI tools into small local components only if readability improves.

Recommendation: extract one `useStreamPageRuntime(streamPath)` for connection/election/DB lifecycle, keep visible SQL in `EventRows`, and delete most custom query policy.

### 12. README is stale

`README.md` still says the body subscribes from the start and renders received events as JSON. It does not explain OPFS SQLite, Web Locks election, cross-tab update behavior, DB download, instant local loads, or TanStack Virtual evaluation. The root experiment README requires those details.

Recommendation: update README after the architecture settles.

## What To Keep

- `ClientOnly`: appropriate for browser-only OPFS/local APIs in a TanStack Start app.
- Web Locks writer election: this is the right cross-tab primitive.
- Dedicated SQLite worker: correct for OPFS and avoids main-thread file work.
- `OPFSCoopSyncVFS`: reasonable for multi-tab OPFS without COOP/COEP.
- TanStack Virtual: correct for enormous lists.
- `useSyncExternalStore`: reasonable for bridging SQLite/BroadcastChannel into React, if the store is made boring.

## Preferred Refactor Shape

1. Simplify schema to `events` only.
2. Delete trigger-maintained `stream_meta`.
3. Delete stream-specific `StreamQueryScope` and tail/range invalidation.
4. Replace the reactive query layer with a small `useSqliteQuery(db, { sql, params, invalidates })`.
5. Make BroadcastChannel only invalidate queries.
6. Let visible route code contain ordinary SQL for count and window rows.
7. Remove row-mode unless still being measured.
8. Serialize worker requests.
9. Let TanStack Virtual handle end anchoring.
10. Update README with the actual browser-storage experiment.

## Open Questions

1. Are stream offsets guaranteed dense from `0..N-1` for this viewer's lifetime?
2. Should browser SQLite retain `processor_state`, or is this page only a stream-event mirror?
3. Is row-at-a-time SQLite write mode still an active experiment parameter?
4. On missed BroadcastChannel messages, is focus/startup reconciliation from SQLite enough?
5. Is preserving old visible rows during window-query refresh a hard UX requirement, or can blank skeleton rows appear briefly?
6. Should the DB runtime be disposed on route change, or intentionally kept hot for back/forward navigation?

# Plan (TODO)

1. Make `events.local_index` the virtualizer index.
   - Use `local_index INTEGER PRIMARY KEY`.
   - Use `offset INTEGER NOT NULL UNIQUE`.
   - Add `inserted_at TEXT NOT NULL DEFAULT (datetime('now'))` to record when the browser mirror stored the row.
   - Store `raw_jsonb BLOB NOT NULL` only; do not store JSON text twice.
   - Treat `raw_jsonb` as the source of truth: `offset`, `type`, `created_at`, and `idempotency_key` must be derived from it and match it.
   - Inspect JSONB through SQLite functions such as `json(raw_jsonb)` or `json_pretty(raw_jsonb)`.
   - `local_index` is zero-based and maps directly to TanStack Virtual item indexes.
   - `offset` is one-based and remains the durable stream cursor.
   - In the current experiment, enforce `local_index = offset - 1` and reject any offset gap.
   - Use SQLite for the invariant: a table `CHECK (local_index = offset - 1)` plus a `BEFORE INSERT` trigger that aborts unless `NEW.offset = COALESCE(MAX(offset) + 1, 1)` or the insert is an identical replay of an existing row.
   - For identical replay, compare canonical JSON text from JSONB (`json(existing.raw_jsonb) = json(NEW.raw_jsonb)`), not raw blob bytes.
   - Identical replay rows should be ignored with `RAISE(IGNORE)` so the original `inserted_at` remains the first time the browser stored that event locally.
   - Comment the trigger heavily: it allows idempotent replay, rejects conflicting duplicate offsets, and rejects offset gaps.
   - Insert every delivered event. SQLite accepts continuous new rows, ignores identical replay rows, and aborts on gaps or conflicting duplicate offsets.
   - Verify in the actual wa-sqlite worker that JSON functions are available before using generated columns or `json_extract()` in schema/inserts.
   - This trigger is acceptable because it protects the append invariant; avoid triggers that maintain derived UI metadata.
   - Comment this clearly in TypeScript and SQL: `local_index` exists so the browser can keep a dense local list, including if server-side event TTL/aging later means local rows no longer map one-to-one to all historical stream offsets.
   - Do not call this column `virtual_index`; "virtual" already belongs to TanStack Virtual.

2. Keep the schema basic and raw-event-only for now.
   - Do not keep `processor_state` in this pass.
   - Do not model the raw SQLite mirror as a browser processor.
   - The subscription sink writes delivered batches directly into `events`.
   - If local browser projections become real later, design a local processor runner explicitly.

3. Make the stream component show the important SQL directly.
   - Total rows query:
     ```sql
     SELECT COUNT(*) AS count FROM events
     ```
   - Visible virtual range query:
     ```sql
     SELECT local_index, offset, type, idempotency_key, created_at, raw_json
     FROM events
     WHERE local_index >= ? AND local_index < ?
     ORDER BY local_index ASC
     ```
   - Re-run these queries when the DB changes.
   - Start with no `COUNT(*)` / `MAX(offset)` avoidance.
   - Use a hybrid `StreamBrowserDatabase` API: generic query support for visible React SQL, explicit methods for writes/lifecycle (`insertEventBatch`, `maxOffset`, `clear`, `download`, `info`, `dispose`, `[Symbol.dispose]`).
   - Mirror the `src/stream.ts` style: one clearly commented schema block and small methods with SQL visible inline.

4. Delete bespoke reactive-query and browser-processor policy.
   - Remove `StreamQueryScope`.
   - Remove tail/range invalidation.
   - Remove trigger-maintained `stream_meta`.
   - Remove `browser.sqlite-projector`.
   - Make BroadcastChannel only mean "the database changed; rerun visible queries".

5. Always write batches.
   - Remove `StreamDatabaseWriteMode`.
   - Remove the row-at-a-time UI toggle.
   - Insert delivered batches in one SQLite transaction.

6. Delete the manual row cache.
   - Remove `rowCacheRef`.
   - Let the visible range query snapshot drive the rendered virtual rows.
   - Accept skeleton rows while a visible range query is refreshing.

7. Make DB/store lifetime explicit.
   - A mounted stream view owns one stream client and one DB runtime.
   - On stream route change, disconnect the old stream client and close/terminate the old DB worker/channel.
   - Do not keep a global per-path DB singleton.
   - Add `/split-stream?left=...&right=...` as a forcing-function route that mounts two independent stream views side by side.
   - Allow the two sides to point at the same stream; both mounted runtimes should independently participate in leadership election, with only one subscriber/writer winning.
   - Each split side renders path selection, connection/election status, the virtualized feed, and the composer.
   - Keep DB download/clear/kill/bulk insert tools on the normal stream page.
   - Share the same core stream feed and composer components between the normal page and split view.
   - Let the normal page and split side use separate wrapper/layout components.

8. Serialize SQLite worker operations.
   - Process worker messages through a one-at-a-time queue.
   - This keeps clear/export/insert/query ordering obvious.

9. Simplify TanStack Virtual follow behavior.
   - Keep `anchorTo: "end"` / `followOnAppend` if it covers the desired behavior.
   - Delete redundant manual append scrolling unless a measured bug requires it.
