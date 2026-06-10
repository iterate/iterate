# Streams

This context defines the language for stream event storage and browser stream viewing in `@iterate-com/streams`.

## Language

**Stream Offset**:
A one-based, continuous position assigned by a stream to each committed event.
_Avoid_: Virtual index, row number

**Local Index**:
A zero-based, continuous browser SQLite position used to render stored stream events as a list.
_Avoid_: Virtual index, stream offset

**Browser Mirror**:
The per-stream SQLite database in the browser, identified by `(namespace, path)` and stored in OPFS under a per-namespace root folder (e.g. `/${namespace}/${path-slug}.sqlite3`). It holds every browser processor's tables for that stream and is shared across all views/components of the stream (one connection per `(namespace, path)` per tab).
_Avoid_: Cache, projection layer; per-processor database (the DB is shared per stream; processors share it)

**Stream View Runtime**:
The component-owned browser runtime for one mounted stream view, including its capnweb client, leadership election, SQLite worker connection, and change notifications.
_Avoid_: Global stream singleton, app-level stream client

**Events Table**:
The browser SQLite table written by the **browser-raw-events** processor. It mirrors delivered stream events, storing the payload once as `raw_jsonb`; scalar columns such as `offset`, `type`, `created_at`, and `idempotency_key` are generated from that JSONB value.
_Avoid_: derived projection (it is a raw mirror, just produced by a processor like any other table)

**Browser Stream Processor**:
A stream processor that runs **in the browser**: the same class-based `StreamProcessor` model that `createStreamProcessorHost` hosts in Workers, hosted here by `acquireStreamRuntime` (`src/browser/stream-browser-store.ts`); the processor's `ingest` is the subscription sink. Each one is selected by its own `view` query param and hosted/run by its own React sub-view component (mounting the sub-view starts the processor). Two exist — **browser-raw-events** (→ `events` table) and **browser-event-feed** (→ `feed_items` table) — many later.
_Avoid_: projector-only mirror, shared connection (each processor has its own connection, even across tabs on the same stream)

**Processor Snapshot (browser)**:
The checkpoint value for one **Browser Stream Processor**: `{ state, offset }`, persisted through the `readState`/`writeState` storage port. In the browser that port is `browserProcessorStateStorage` (`src/browser/processor-state-storage.ts`), backed by the shared `processor_state` table in the **Browser Mirror** — including for `browser-raw-events`, whose schema resets clear its checkpoint row together with the `events` table.
_Avoid_: Processor state without offset

**Processor Stem**:
The single kebab-case name that identifies a **Browser Stream Processor** and deterministically generates its identity surfaces: query param value = stem; processor slug + folder = `browser-` + stem; processor name = Title Case(stem); React component = Pascal(stem) + `View`. Tables are NOT derived from the stem — a processor declares its own table(s), free-form snake_case, and may own several. The two stems:

- `raw-events` → slug/folder `browser-raw-events`, name "Raw events", table `events`. BUILT and wired into the default raw-events view.
- `event-feed` → slug/folder `browser-event-feed`, name "Event feed", table `feed_items` (more tables possible later). BUILT and wired into the event-feed view; grouping lives in pure `planFeedOps`, with browser writes committed through `processEventBatch` + `sql.batch(transaction)`.
  _Avoid_: pretty (renamed to event-feed); the `-browser` suffix form (slug is `browser-` prefix, matching the `processors/<slug>/` folder); deriving a table name from the stem

**Feed Item**:
One row in `feed_items`, written by the `browser-event-feed` processor. Columns: `local_index` (dense 0-based PK, what TanStack Virtual indexes), `component` (the React component name to render), `first_offset` + `last_offset` (offset span), `event_count`, and `data` (a JSON blob holding whatever that component needs to render). Two cases per event:

- the event's type **has a specific renderer** (e.g. `created` → `"stream.created"`, `woken` → `"stream.woken"`, `child-stream-created` → `"stream.child-stream-created"`): write it as its OWN row (`event_count = 1`). A specific-renderer event also **closes** any open group.
- the event's type **has no specific renderer**: **upsert the open group** — extend the current group row (`event_count++`, `last_offset`, update `data`) if one is open, else insert a new group row (e.g. component `"group"`).
  So grouping only collapses _consecutive events lacking a specific renderer_ into one group row; specific-renderer events are always singletons. The reduced `state` tracks whether the last row is an open, extendable group.
  _Avoid_: UI element, feed row, grouped event (use "Feed Item"); "group by component" (the rule is specific-renderer → own row, else upsert a group); typed render columns (render payload is the single `data` JSON blob)

**Feed Item rendering**:
The view is a pure, edge-case-free map from rows to components: the windowed SQLite query yields plain row objects, and `EventFeedView` does `windowRows.map(row => { const C = COMPONENTS[row.component]; return <C key={row.local_index} {...row.data} /> })`. The **row is the sole input** — `component` selects the React component, `data` is its props; nothing else is consulted (no event lookups, joins, or fallbacks). All "which component / what props" intelligence lives in the processor when it writes the row; React stays a dumb `component name → React component` table. The processor's contract with the view: every row it writes is self-contained and directly renderable.
_Avoid_: deciding components/props in React; reading anything but the row to render

## Relationships

- A **Stream Offset** starts at `1` for the first committed event in a stream.
- A **Stream Offset** is the durable resume cursor for browser subscriptions.
- A **Local Index** starts at `0` and maps to exactly one locally stored stream event.
- Currently a **Local Index** is always `Stream Offset - 1`; SQLite rejects any gap in **Stream Offset**.
- **Local Index** is separate from **Stream Offset** so the browser can eventually keep a dense local list even if the server later ages out events by TTL.
- A **Stream View Runtime** writes delivered server batches directly into the **Events Table** in one transaction.
- Replayed events with already-stored **Stream Offsets** are valid only when the JSON payload is identical; identical replays are ignored and keep the original `inserted_at`.
- Same-offset events with different JSON are storage errors.
- Any committed browser SQLite change wakes all mounted browser SQLite queries; this is intentionally blunt until measured otherwise.
- Browser change notifications may include append/clear details for observability, but SQLite remains the source of truth for counts and rows.
- `raw_jsonb` is stored only once as SQLite JSONB; inspect it with SQLite JSON functions such as `json(raw_jsonb)` or `json_pretty(raw_jsonb)`.
- A **Browser Mirror** row records `inserted_at`, the time the browser first stored that event locally.
- A **Stream View Runtime** is owned by the mounted React view; unmounting the view closes that runtime.
- Multiple **Stream View Runtimes** may exist in one browser tab. `/split-stream?left=...&right=...` renders two of them side by side.
- If two **Stream View Runtimes** mount the same stream path, they both participate independently in writer election; one becomes the subscriber/writer and the other follows the shared **Browser Mirror**.
- Each **Browser Stream Processor** is hosted by its React sub-view and has its own capnweb connection; mounting the sub-view starts the processor, unmounting stops it. A processor's table only advances while its sub-view is mounted, and catches up on remount by resuming from its own checkpoint.
- The events mirror is itself a **Browser Stream Processor** (the `browser-raw-events` processor), not a special generic copy path — symmetric with `browser-event-feed` and every later one.
- A **Browser Stream Processor** may write more than one table, but keeps exactly one **Processor Snapshot** row; it writes all its tables and bumps that row's `max_offset` in one transaction, so resume is correct regardless of table count.
- Two dedup scopes keyed on `(stream path, processor slug)`: (1) cross-tab, Web Locks elect ONE writer/leader across all tabs (others are read-only followers); (2) within one tab, a ref-counted registry shares ONE runtime instance (one capnweb connection + one processor runner) across an arbitrary number of React views with that key.
- Same-stream split views share one within-tab runtime per `(namespace, path, slug)` and therefore report the same leader/follower state for that processor. Cross-tab handoff is unaffected because separate JS contexts still elect independently.
- Connection count = number of distinct `(path, slug)` runtimes mounted in a tab. Two streams × two processors = 4 connections; a 5th view reusing an existing `(path, slug)` adds 0. The first view for a key creates the runtime; the last to unmount tears it down.
- The SQLite connection (wa-sqlite worker / `Browser Mirror`) is shared per `(namespace, path)` (one worker per stream per tab), via a ref-counted registry beneath the `(path, slug)` runtime registry. Both registries use one small generic ref-count helper; a stream's multiple processors share one DB worker (no intra-tab OPFS handle contention).
- `acquireStreamRuntime` (`src/browser/stream-browser-store.ts`) is the live browser surface, used by `apps/os`'s `project-stream-view.tsx` and the example-app views. A view passes its `BrowserProcessorConfig` — `slug`, `schemaVersion` (folded into the writer-lock name), `tables` (cleared on mirror discard), and `createProcessor({ stream, sql, subscriptionKey })` constructing the class-based processor. The returned `StreamBrowserStore` ALWAYS opens a capnweb connection (so a follower can still `appendBatch` / read `runtimeState`), elects the Web Lock on the subscription key, and ONLY as leader hosts the processor: it reads the processor's `snapshot()` for the replay cursor, subscribes, and pumps delivered batches into `processor.ingest`. Ref-counting/dedup per `(namespace, path, slug)` is hidden inside `acquireStreamRuntime`; the shared **Browser Mirror** DB is ref-counted one level up per `(namespace, path)`.
- Reactive reads go through `useStreamQuery(db, sql, params)` (`src/browser/hooks/use-stream-query.ts`), an ordinary SQL query over the **Browser Mirror** re-run on committed changes.
- Identity keys carry the namespace: `subscriptionKey = ${namespace}:${browserSubscriberId}:${slug}`; the Web Lock name = `${namespace}:${path}:${subscriptionKey}`, versioned by browser DB schema. Leadership and the stream subscription are both keyed on the subscription key.
- The namespace is the constant `"default"` for now (renamed from `"stream"` to avoid confusion with the stream concept), threaded explicitly from the route as part of `(namespace, path)`; browser libs never hardcode it. Requires `example-app/src/worker.ts` to name the DO `default:${path}` (was `stream:${path}`).
- The browser `browser-raw-events` processor owns the `events` table schema and writes each delivered batch with `sql.batch(..., { transaction: true })` from its `processEventBatch` override; the base class only checkpoints after that hook resolves, so the checkpoint stays behind committed rows. Write errors surface through the wrapped `SqlClient`. The processor's one-time `prepare()` runs `ensureBrowserRawEventsSchema(sql)` (including version resets) before the checkpoint is first read.
- `browser-raw-events` checkpoints like every other processor: its `{ state, offset }` row lives in the shared `processor_state` table (via `browserProcessorStateStorage`), NOT in the `events` table. The `events` table is its output, not its checkpoint; schema-version resets clear the table and its checkpoint row together. Because the checkpoint only advances after rows commit, replay is safe (the events trigger ignores identical re-inserts).
- Checkpointing is the BASE CLASS's job, not the subclass's. After `processEventBatch` resolves (and any `blockProcessorWhile` work completes), `StreamProcessor` persists `{ reduced state, offset }` via its `readState`/`writeState` storage port. The storage port may be a dedicated state row (browser `processor_state`), Durable Object storage, or in-memory for tests.
- A browser processor's `deps` is just a plain SQLite client; `processEvent`/`processEventBatch` mutates whatever tables it owns directly (`sql.exec(...)` / `sql.batch(...)`), no debounced/buffered wrapper.
- Because the base class awaits `processEventBatch` (and registered `blockProcessorWhile` work) before saving `{state, offset}`, the checkpoint never advances ahead of the processor's committed rows. The processor's own tables hold the rendered rows (processor-written); the storage port holds the reduced state and offset. Replay from the saved offset is idempotent.

## Example Dialogue

> **Dev:** "Can the browser viewer use the **Stream Offset** directly for replay?"
> **Domain expert:** "Yes. Subscribers resume after the highest **Stream Offset** fully stored in SQLite."
>
> **Dev:** "Can TanStack Virtual use the **Stream Offset** as its item index?"
> **Domain expert:** "No. It uses the zero-based **Local Index**, while the **Stream Offset** remains the one-based durable cursor."
>
> **Dev:** "If reconnect replays offsets 99 and 100 after the browser already stored them, is that a gap?"
> **Domain expert:** "No. Replay overlap is fine when the payload is identical, but the first new event after the overlap must be the next continuous **Stream Offset**."

## Flagged Ambiguities

- "virtual index" has been used both for TanStack Virtual's zero-based item index and a browser SQLite column; resolved: use **Local Index** for browser SQLite and avoid "virtual index" as a domain term.
- The browser-processor design was removed in a refactor, then deliberately reinstated: the goal is to practise writing real stream processors locally, one per view, each owning a table + connection + sub-view. Open: the debounce mechanism for SQLite writes, and whether per-processor leadership election is kept (vs. relying on insert idempotency when two tabs run the same processor).
