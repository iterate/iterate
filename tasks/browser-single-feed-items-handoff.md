---
state: todo
priority: high
size: large
tags: [os, streams, browser-feed, sqlite, agent-feed]
---

# Browser stream feed should have one feed item abstraction

## User intent

The browser stream mirror should expose one feed item abstraction, not a
"pretty feed" table plus a separate "raw grouped feed" table that the React view
tries to stitch together.

Target model:

- One browser feed item abstraction for anything rendered in the stream feed.
- Two user-facing SQLite content tables for a stream path:
  - `events`: raw committed stream events.
  - `feed_items`: derived rendered rows.
- `feed_items` has one total monotonic ordering within the stream path. The UI
  should render `ORDER BY local_index` (or equivalent), not union two feed
  tables and invent ordering in React.

Internal processor bookkeeping tables such as `processor_state` / mirror meta
may still exist unless the owner literally wants only two SQLite tables total.
Do not confuse those internals with the two content-table model above.

## What went wrong

PR #1837 kept two feed abstractions:

- `agent_feed_items`: nice agent rows.
- `feed_items`: raw grouped/debug rows.

Then Pretty + raw rendered those as split panes. A later attempted correction
started heading toward a SQL `UNION` of those two tables. That is still the
wrong model. The owner wants one feed item stream in the browser, with pretty
and raw rows interspersed because they are both feed items.

Do not solve this by:

- Adding another table for agent rows.
- Sorting two feed tables together in the view.
- Rendering Pretty + raw as a raw rail under/next to the chat.
- Moving processor runtime state into the browser DB. Runtime lag/cursor/parked
  state belongs to the server itx runtime surface.

## Current code shape

Relevant files:

- `apps/os/src/components/project-stream-view.tsx`
  - Owns the browser stream view and currently wires three browser processors.
- `apps/os/src/components/agent-feed.tsx`
  - Renders nice agent rows from `agent_feed_items`.
- `apps/os/src/components/feed-items-view.tsx`
  - Renders grouped raw rows from `feed_items`.
- `apps/os/src/domains/streams/client-libraries/processors/agent-ui-processor.ts`
  - Owns `agent_feed_items` and agent reduced state.
- `apps/os/src/domains/streams/client-libraries/processors/browser-event-feed/implementation.ts`
  - Owns `feed_items` for raw grouped rows.
- `packages/ui/src/components/events/agent-ui-reducer.ts`
  - Shared reducer that derives nice agent UI items and live state.

As of this handoff, the branch should not contain partial code changes from the
aborted interleaving attempt. Start from current `origin/main`.

## Desired data model

`events` remains the raw append-only browser mirror.

`feed_items` should become the single rendered-feed projection. Suggested
columns:

```sql
CREATE TABLE feed_items (
  local_index INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,
  first_offset INTEGER NOT NULL,
  last_offset INTEGER NOT NULL,
  event_count INTEGER NOT NULL DEFAULT 1,
  data BLOB NOT NULL
);

CREATE INDEX feed_items_offsets_idx
  ON feed_items(first_offset, last_offset);

CREATE INDEX feed_items_kind_idx
  ON feed_items(kind);
```

`local_index` is the total feed order. Important: stream processors replay
batches, so this must be deterministic/idempotent. A plain SQLite
`AUTOINCREMENT` insert is probably wrong unless there is also a stable
idempotency key and replay does not allocate a second row. The existing browser
processors already use a reducer-state `nextLocalIndex`; that pattern matches
at-least-once replay better than relying on SQLite allocation.

Potential `kind` values:

- `agent.user-message`
- `agent.assistant-message`
- `agent.activity`
- `agent.stream-woken`
- `agent.child-stream-created`
- `agent.stream-paused`
- `agent.stream-resumed`
- `raw.group`
- `raw.singleton`

Names are not important; the invariant is that every rendered row is a
`feed_items` row.

## Ordering semantics

The feed projector, not the React view, owns ordering.

For each event, the projector can emit zero, one, or multiple feed item
mutations. When multiple feed rows are caused by the same offset, the projector
must choose an order and assign `local_index` in that order.

Agent activity is the hard case:

- If the owner wants the activity row to appear where work started, create the
  `agent.activity` feed item when the activity opens and update it in place as
  steps complete.
- If the owner wants the activity row to appear retrospectively, create it when
  the activity settles.

Current pretty-feed behavior visually implies "activity appears between the
user message and the assistant response", so creating the activity row at start
and updating it later is likely the right product model.

Raw grouping is also an update-in-place case:

- A `raw.group` row starts at its first event.
- Later same-type events update that row's `last_offset`, `event_count`, and
  `data`.
- The row keeps its original `local_index`.

That means Pretty + raw is interspersed at feed-item granularity, not necessarily
one visible raw row per event.

## Processor architecture

One processor should own writes to `feed_items`. Two independent processors
writing the same table cannot safely coordinate a single total `local_index`
without a central allocator, and a central allocator is unnecessary complexity.

Likely shape:

- Keep `browser-raw-events` as the owner of `events`.
- Replace/consolidate `agent-ui-processor` and `browser-event-feed` feed-row
  writes into one browser feed projector that owns `feed_items`.
- That projector can reuse/refactor the existing agent reducer and raw grouping
  logic, but it must produce one ordered stream of feed item insert/update ops.
- Agent live state, presence, and token usage can still be reduced state for the
  feed projector if the view needs them for the live tail/header. They should
  not require a separate `agent_feed_items` table.

If keeping a separate `agent-ui` processor for live state is unavoidable, it
must not own a second feed table. Also avoid two processors both writing
`feed_items` unless there is a reviewed design for idempotent ordering.

## View behavior

The React feed should have one virtualized list over `feed_items`.

Modes become filters over the same table:

- Pretty: show nice agent rows, hide raw debug rows.
- Pretty + raw: show nice agent rows and selected raw rows in one list ordered
  by `local_index`.
- Raw: show raw/debug feed rows and keep raw event inspector access.

Pretty + raw should still support choosing which raw groups/event types to show.
Filtering raw rows must not remove nice rows unless the mode/search explicitly
says so. A useful SQL shape is:

```sql
WHERE
  kind NOT LIKE 'raw.%'
  OR (kind LIKE 'raw.%' AND <raw filters>)
ORDER BY local_index ASC
```

Search semantics need a product call:

- Search could apply to nice rows only in Pretty + raw, while raw type/component
  filters apply only to raw rows.
- Or search could apply to both. The previous direction was "Pretty + raw search
  is for the pretty feed"; raw rows are controlled by raw filters.

## Migration / rebuild stance

These browser mirrors are disposable projections. Prefer a schema-version bump
and local rebuild over a complicated migration. The new projector should clear
old `agent_feed_items` usage and rebuild `feed_items` from `events`.

If old `agent_feed_items` tables remain in existing browser DB files, they
should be ignored or dropped as part of cleanup. The product model should not
read from them.

## Acceptance criteria

- There is no `agent_feed_items` user-facing content table in the active feed
  path.
- Pretty, Pretty + raw, and Raw are all backed by `feed_items`.
- Pretty + raw is one scrolling list, not split panes.
- Raw grouped debug access remains available from Pretty + raw by clicking raw
  rows / opening the raw event inspector.
- Raw filters in Pretty + raw can select which raw groups/event types appear.
- Feed ordering is a single deterministic per-stream `local_index`.
- Runtime subscription state in the processor sheet is fetched from server itx
  runtime state, not browser SQLite.
