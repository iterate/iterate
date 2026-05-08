# Events Stream View Components

This directory is the clean-room implementation for rendering an events stream.

The core idea is intentionally small:

1. Start with raw `Event[]` from the events oRPC client.
2. Select one view reducer for the current view mode.
3. The reducer synchronously reduces events into view state.
4. React renders `state.slots` by slot name and rendered element `type`.
5. Raw summary rows open the shared event inspector for full payload navigation.

Rendered Elements are serializable data structures that map to UI components.
The feed is one slot, so feed items are Rendered Elements placed in the feed.
Processors can also project Rendered Elements into header and input slots
without turning React components into reducers.

Raw event rows, grouped raw event rows, semantic cards, and raw JSON dumps
remain feed-slot Rendered Elements. Do not create a separate concept of "raw
items" versus "feed items" inside the feed slot.

## Files

- `CONTEXT.md` defines the shared language: Rendered Element, Slot, Feed Item,
  and Stream View Reducer.
- `DESIGN-EXPLORATION.md` sketches the slot model, prototype shapes, risks, and
  open questions for the next refactor pass.
- `REFACTOR-ROADMAP.md` lists the current code gaps and a prioritized migration
  path.
- `SLOT-PROTOTYPES.md` sketches concrete event-to-slot snapshots that can later
  become tests.
- `feed-items.ts` defines `EventsStreamRenderedElement`, built-in element prop
  types, `EventsStreamSlots`, and the reduced stream view state.
- `feed-processors.ts` defines selectable view reducers.
- `stream-layout.tsx` defines the package-owned header/main/message-input
  layout regions for browser stream UIs.
- `stream-feed.tsx` renders the stream view and feed items by `item.type`.
- `event-inspector-sheet.tsx` renders the shared raw event detail drawer.

## Reducers

Reducers are the view policy. If a dropdown mode wants different content, add
or select a different reducer.

The shape follows the same reducer discipline as the stream processor contracts
under `apps/agents/src/stream-processors`: each reducer is plain data plus a
pure `reduce({ event, state })` function. Rendering concerns stay outside the
reducer.

Current primary reducers:

- `rawPrettyEventsStreamViewReducer` is the default stream view: each event
  contributes to a raw summary feed item and may also contribute one semantic
  feed item. Consecutive unsupported events with the same type may collapse into
  a grouped summary only when each event produced no other feed item, but the
  group keeps every raw event for inspector navigation.
- `rawJsonDumpEventsStreamViewReducer` emits one `raw-json-dump` item.

`rawEventsStreamViewReducer` and `prettyEventsStreamViewReducer` may remain as
debugging helpers while the UI settles, but they are not the target product
shape and should not appear in the visible renderer-mode controls. If an old
clean-renderer link carries `renderer=raw` or `renderer=pretty`, the clean view
falls back to `raw-pretty`.

All reducers also share small cross-slot projections:

- event counts become an `event-counter` element in the header slot.
- active LLM requests become an `activity` element in the header slot.
- stream error events become a `composer-suggestion` element in the input slot.

Keep reducers explicit. Start with a small number of named reducers and extract
plain helper functions when they share real behavior. Do not add a reducer
composition abstraction until the code has repeated pressure that makes the
simple helper approach painful.

## Renderers

Renderers are deliberately broader than any one view. It is fine for a renderer
to exist even when the selected processor never emits that item type.

Do not make renderer selection depend on the dropdown mode. The mode selects the
reducer; `item.type` selects the renderer.

This directory currently has a web renderer in `stream-feed.tsx`. The Bun +
OpenTUI proof of concept in `apps/agents/scripts/event-stream-terminal.ts`
reuses `feed-items.ts` and `feed-processors.ts`, but defines its own terminal
renderer. That is the intended split: processors and feed item data are shared;
renderers belong to each UI runtime.

Input-slot elements are allowed to expose serializable actions such as
`prefill-agent-message`. The reducer only describes the action. The host app
decides what to do when the user explicitly accepts it, so replaying a stream
does not silently mutate composer state.

## Shape Rules

- Rendered Elements must be serializable data structures.
- Use `item.type` as the discriminant.
- Put component-specific data under `item.props`; the only universal top-level
  fields are `id`, `type`, and `props`.
- Keep stable identifiers in `item.id`; React keys use this field.
- Keep domain reduction logic out of React components.
- Write new renderer-aware projections to `state.slots.{feed,header,input}`.
- Raw summary elements must keep their source event data so click-through detail
  and previous/next navigation remain faithful to the wire log.
- `state.outlets` and `state.feedItems` remain deprecated compatibility aliases
  while older terminal/rendering code finishes migrating; do not use them in new
  code.
- Input-slot elements should render affordances or explicit actions. They should
  not directly mutate a composer during event replay.
- Put new item types in `feed-items.ts`, add processor support in
  `feed-processors.ts`, and add rendering in `stream-feed.tsx`.
- If a Rendered Element needs provenance, include explicit event fields or raw
  source event data. Do not hide provenance in component state.
