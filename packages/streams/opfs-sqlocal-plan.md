# OPFS + SQLocal stream staging plan

## Goal

Move the browser stream viewer from an in-memory event array to a local SQLite staging area:

- the CapnWeb browser subscription still receives `processEventBatch({ events })` calls;
- the subscription sink writes received batches into SQLite through SQLocal/OPFS;
- React reads stream rows from a reactive SQLite query instead of `snapshot.events`;
- the first implementation stays experiment-local and intentionally boring.

This is a staging experiment, not the final production abstraction. Prefer the smallest working
shape that proves: CapnWeb -> local SQLite -> reactive React UI.

Conceptually, the browser subscriber is a stream processor. It should eventually look like the
experiment's built-in processors: a reducer owns durable processor state, and `afterAppend` performs
the side effect. For the browser subscriber, the side effect is writing event batches to SQLite.

## Current simplest implementation

Use one SQLocal database file per stream, created lazily by stream path:

```ts
import { SQLocal } from "sqlocal";

export function createStreamDb(streamPath: string) {
  return new SQLocal({
    databasePath: streamPath === "/" ? "/streams/_db.sqlite3" : `/streams${streamPath}/_db.sqlite3`,
    reactive: true,
  });
}
```

Use SQLocal's vanilla cross-tab read path: `reactive: true`. SQLocal already uses browser
broadcast channels internally for reactive query effects between clients on the same database.
That covers UI reads, not stream subscription ownership.

Each browser tab should still have its own CapnWeb stream connection. That connection is the tab's
command/control channel: it can call `appendBatch()`, `kill()`, debug methods, and future RPC
methods without going through another tab.

Only one tab per stream path should be subscribed to event delivery. The elected subscription owner
calls `stream.subscribe(...)`, receives replay/live `processEventBatch({ events })` calls, and writes
those events into the shared SQLocal database. Other tabs render the same rows through SQLocal
reactive queries.

Use a small leader-election library for this rather than hand-rolled tab coordination. The
candidate is [`broadcast-channel`](https://github.com/pubkey/broadcast-channel), specifically
`createLeaderElection(channel)`, which uses browser primitives such as Web Locks where available and
falls back for older runtimes. The election channel should be keyed by stream path, for example
`stream-subscription:${streamPath}`.

This keeps the layering explicit:

- CapnWeb connection: per tab, used for commands.
- CapnWeb subscription: one elected tab per stream path, used for event delivery.
- SQLocal database: one file per stream path, used as the cross-tab read model.
- React UI: all tabs read from SQLocal reactive queries.

Do not enable SQLite WAL mode in the first implementation. Normal server SQLite advice does not
carry over cleanly to SQLite WASM + OPFS: SQLite's own WASM persistence docs say WAL on OPFS requires
exclusive locking immediately after opening, and that OPFS locking/concurrency is still evolving
([SQLite WASM OPFS persistence](https://sqlite.org/wasm/doc/tip/persistence.md)). For this
experiment, the higher-performance setting is one writer queue, one SQL transaction per CapnWeb
batch, and `tx.batch()` for repeated inserts. That keeps cross-tab reactive reads simple and keeps
whole-database download/export semantics obvious.

The database path mirrors the stream path hierarchy:

- stream `/` -> `/streams/_db.sqlite3`
- stream `/bla/bla` -> `/streams/bla/bla/_db.sqlite3`

This makes the downloaded artifact and the local OPFS layout correspond directly to the stream tree.
The browser download filename should flatten the hierarchy into a recognizable name, e.g.
`streams__bla__bla__db.sqlite3` for `/bla/bla`, because ordinary browser downloads do not preserve
folder structure.
The download should be the whole SQLite database file for that stream, including every table in the
file. It is not a special events-only export.
The first schema should still contain only the `events` table.

Add SQLocal's Vite plugin so worker files and local dev headers are handled by the package. The
current `vite.config.ts` has only Cloudflare, TanStack Start, and React plugins, so this is an
explicit setup step.

The first version should have three small browser-side pieces:

- `stream-browser-db.ts`: owns the SQLocal instance and schema setup.
- `stream-browser-store.ts`: owns the CapnWeb connection/subscription status.
- `StreamPage`: reads rows with SQLocal `reactiveQuery()` through React `useSyncExternalStore()`.

Use one downloadable SQLite database file per stream. That keeps the schema simple, makes the local
artifact meaningful on its own, and avoids per-stream autoincrement/reindexing problems inside a
shared multi-stream database.

Do **not** implement reconnect optimization, pruning, or ingest run history in the first pass.
Windowed reads are part of the first pass because the UI should not hold the entire stream in React
memory. Cross-tab subscription-owner election is the first cross-tab coordination we should add;
avoid broader cross-tab command proxying because every tab owns its own CapnWeb connection.

## Source constraints

- SQLocal runs SQLite in a web worker and persists to OPFS when available
  ([SQLocal intro](https://sqlocal.dev/guide/introduction)).
- SQLocal's Vite plugin configures web worker handling and enables cross-origin isolation for Vite
  dev; production needs equivalent headers for OPFS persistence
  ([SQLocal setup](https://sqlocal.dev/guide/setup)).
- SQLocal `reactiveQuery` requires `reactive: true`; React can subscribe with
  `useSyncExternalStore` ([reactiveQuery](https://sqlocal.dev/api/reactivequery)).
- SQLocal exposes `transaction()` for atomic multi-statement writes and `batch()` for repeated
  statements ([transaction](https://sqlocal.dev/api/transaction),
  [batch](https://sqlocal.dev/api/batch)).
- `getDatabaseInfo()` reports `storageType` and `persisted`, which should be shown in a debug panel
  for this experiment ([getDatabaseInfo](https://sqlocal.dev/api/getdatabaseinfo)).
- OPFS is origin-private, quota-managed browser storage. Clearing site storage deletes it
  ([MDN OPFS](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system)).

## Minimal data flow

1. React mounts `/streams/$` for `streamPath`.
2. Browser DB module initializes SQLocal and runs `CREATE TABLE IF NOT EXISTS`.
3. Stream store opens CapnWeb with `withStream({ url })`.
4. Store participates in leader election for `streamPath`.
5. The elected tab calls `connection.stream.subscribe({ subscriptionKey, sink, replayAfterOffset })`.
6. `sink.processEventBatch({ events })` enqueues the batch and returns immediately.
7. A single async writer drains batches in order.
8. Each drained batch inserts rows in one SQLite transaction.
9. SQLocal cross-tab reactive queries rerun when `events` changes.
10. `EventRows` virtualizes the reactive rows exactly like it currently virtualizes `snapshot.events`.

The first version should subscribe from the start. That means the elected subscription tab can
replay old stream events and hit `INSERT OR IGNORE`. This is acceptable for the first proof because
it avoids checkpoint plumbing while still proving local storage and reactive reads.

The intended production behavior is still max-offset resume. Once the basic path works, the browser
processor should read the local maximum contiguous offset from SQLite and subscribe after that
offset.

## Minimal schema

Start with exactly one table:

```sql
CREATE TABLE IF NOT EXISTS events (
  virtual_index INTEGER PRIMARY KEY AUTOINCREMENT,
  offset INTEGER NOT NULL,
  type TEXT NOT NULL,
  idempotency_key TEXT,
  created_at TEXT NOT NULL,
  raw_json TEXT NOT NULL,
  UNIQUE (offset)
);
```

Use `INSERT OR IGNORE` for the first version:

```sql
INSERT OR IGNORE INTO events (
  offset,
  type,
  idempotency_key,
  created_at,
  raw_json
) VALUES (?, ?, ?, ?, ?);
```

This keeps duplicate replay simple. Do not compare duplicate payloads yet.
`raw_json` should be `JSON.stringify(event, null, 2)`, because CapnWeb gives the browser structured
event objects rather than raw wire bytes.
`idempotency_key` is nullable; `NULL` means the event did not include one.
Within one per-stream database, `offset` is the logical stream-event identity and the replay dedupe
key.

## Minimal reactive query

The UI should use windowed SQL reads from day one. TanStack Virtual remains responsible for the
scroll model and visible range, but React should only hold the currently visible SQL window plus
overscan in memory.

Keep `virtual_index` separate from stream `offset`. Stream offset is durable stream identity.
Virtualizer index is local presentation order over the events currently retained in SQLite. They are
not the same thing: future streams may have server-side TTL, so a browser can connect after older
events have aged out and receive non-contiguous offsets. The local `virtual_index` should therefore
be assigned as a local ingest order. Because each stream has its own SQLite database, this can be a
plain SQLite `INTEGER PRIMARY KEY AUTOINCREMENT`.

```ts
const rows = useStreamReactiveQuery(
  streamDb,
  (sql) => sql`
  SELECT virtual_index, offset, type, idempotency_key, created_at, raw_json
  FROM events
  ORDER BY virtual_index ASC
  LIMIT ${limit}
  OFFSET ${startIndex}
`,
);
```

The virtualizer `count` should come from a separate count query:

```ts
const count = useStreamReactiveQuery(
  streamDb,
  (sql) => sql`
  SELECT virtual_index
  FROM events
  ORDER BY virtual_index ASC
`,
);
```

SQLocal 0.18's reactive table analyzer does not currently recognize `SELECT count(*) FROM events`
as reading `events`, and it also does not recognize the plain projection without `ORDER BY`. The
first implementation therefore keeps the schema to the single requested table and counts ordered
projected integer keys in React. This is exact, unlike `MAX(virtual_index)`, because SQLite
`AUTOINCREMENT` can advance on ignored duplicate inserts during replay. It is still not the final
large-stream shape: a future browser-processor state table can maintain a reactive event count
without reading one row per event.

Rows rendered by `EventRows` are then the SQL window, not every row in the stream. The existing
TanStack Virtual investment still pays off: it controls scroll size, visible indexes, and overscan;
SQLite controls which rows are loaded into memory.
The UI should not parse event JSON for display. Collapsed rows use projected columns (`offset`,
`type`, `created_at`); expanded rows render the `raw_json` text column directly.

Connection/subscription status remains runtime state in `stream-browser-store.ts`. Event rows move
to SQLite.
Remove the in-memory `snapshot.events` path completely. This experiment should prove the SQLite
path, not keep a parallel fallback that can hide failures.

## Minimal writer

The sink should return immediately and let a single writer promise serialize writes:

```ts
class BrowserSubscriptionSink extends RpcTarget implements SubscriptionSink {
  processEventBatch(args: { events: StreamEvent[] }) {
    // Do not await SQLite here. The stream deliberately sends event batches one-way;
    // awaiting would add subscriber-originated ack traffic to the hot path.
    enqueueWrite(args.events);
  }
}
```

The writer runs one SQLocal transaction per CapnWeb batch and uses `batch()` inside that transaction
for the repeated `INSERT OR IGNORE`. If a batch is huge, chunk later after measurement; the stream
currently catches up in batches of 100, which is already a useful baseline.

On DB write failure, set connection status to `error` and dispose the CapnWeb session. Do not keep
receiving events that cannot be staged.
Do not implement automatic writer recovery in the first cut; fail closed and let a remount reconnect.

For the first cut, derive diagnostics from `events` instead of storing separate processor
state. Later, when the browser subscriber is modeled more directly as a stream processor, store its
reduced state and most recent processed offset explicitly.

## Lifecycle

- Keep one SQLocal instance per stream path while that stream page is active.
- Keep one CapnWeb stream connection per tab while that stream page is active.
- Dispose the tab's CapnWeb connection when the route store unmounts.
- Dispose the CapnWeb subscription only in the elected subscription-owner tab.
- If the subscription-owner tab unmounts or closes, another tab should win election and subscribe
  from the local SQLite max offset.
- Let React `useSyncExternalStore` clean up SQLocal reactive-query subscriptions.
- Add one explicit UI control to clear the current stream's local SQLite database.
- Add one explicit UI control to download the current stream's SQLite database file.
- Show a small sidebar diagnostic block from day one: `crossOriginIsolated`, SQLocal
  `storageType`, `persisted`, and database size.
- Put Download DB and Clear local DB controls in the sidebar next to those diagnostics.

## Deferred work

- Browser processor state table containing reduced state and most recent processed offset.
- Reconnecting with `replayAfterOffset` derived from that processor state.
- Cross-tab subscription-owner election with `broadcast-channel`.
- More sophisticated offset-window caching for 100k+ rows.
- TTL/pruning behavior that can make `virtual_index` diverge from stream `offset`.
- Retention/pruning policy.
- Duplicate payload comparison.
- Persisted-storage prompt strategy.
- OPFS behavior on deployed Cloudflare Worker versus local Vite dev.

## First implementation checklist

1. Add `sqlocal` dependency and SQLocal Vite plugin.
2. Add COOP/COEP headers for deployed Worker responses.
3. Add `stream-browser-db.ts` with SQLocal singleton, schema setup, and insert-batch function.
4. Change `stream-browser-store.ts` so `processEventBatch` writes to DB instead of JS array.
5. Change `StreamPage` to query event rows with SQLocal `reactiveQuery`.
6. Keep the existing virtualized row rendering and composer controls.
7. Add diagnostics and a clear-local-db control.
8. Verify reload preserves rows and no longer needs an in-memory event array.

## Open questions

- The first pass subscribes from the start and relies on `INSERT OR IGNORE`. The next pass should
  resume from the local max contiguous offset.
- The first pass should use a windowed row query. TanStack Virtual controls the visible range; SQLite
  provides only the rows needed for that range.
- Clearing local data is per stream because each stream has its own database file.
