# Events Feed Components

This directory is the clean-room implementation for rendering an events stream.

The core idea is intentionally small:

1. Start with raw `Event[]` from the events oRPC client.
2. Select one view processor for the current view mode.
3. The processor synchronously reduces events into view state.
4. React renders `state.feedItems` by `item.type`.

Raw event rows, grouped raw event rows, semantic cards, and raw JSON dumps are
all feed items. Do not create a separate concept of "raw items" versus "feed
items". A view is just a processor that chooses which feed items to emit while
also projecting any other state the UI needs.

## Files

- `feed-items.ts` defines the serializable feed item model.
- `feed-processors.ts` defines selectable view processors.
- `stream-feed.tsx` renders feed items by `item.type`.

## Processors

Processors are the view policy. If a dropdown mode wants different content, add
or select a different processor.

The shape follows stream processors such as
`apps/agents/src/durable-objects/agent-processor.ts`: each processor has
`slug`, `createInitialState()`, and `reduce({ event, state })`.

Current processors:

- `rawEventsStreamViewProcessor` emits one `raw-event` item per event.
- `prettyEventsStreamViewProcessor` emits only semantic items.
- `rawPrettyEventsStreamViewProcessor` interleaves grouped raw events and
  semantic items.
- `rawJsonDumpEventsStreamViewProcessor` emits one `raw-json-dump` item.

Keep processors explicit. Prefer adding a new named processor over adding a mode
parameter with conditionals. If processors start sharing complicated logic,
extract small helpers at the bottom of `feed-processors.ts`.

## Renderers

Renderers are deliberately broader than any one view. It is fine for a renderer
to exist even when the selected processor never emits that item type.

Do not make renderer selection depend on the dropdown mode. The mode selects the
processor; `item.type` selects the renderer.

This directory currently has a web renderer in `stream-feed.tsx`. The Bun +
OpenTUI proof of concept in `apps/agents/scripts/event-stream-terminal.ts`
reuses `feed-items.ts` and `feed-processors.ts`, but defines its own terminal
renderer. That is the intended split: processors and feed item data are shared;
renderers belong to each UI runtime.

## Shape Rules

- Feed items must be serializable data structures.
- Use `item.type` as the discriminant.
- Keep stable identifiers in `item.id`; React keys use this field.
- Keep domain reduction logic out of React components.
- View state is allowed to contain more than `feedItems`; for example,
  `state.activity.currentLlmRequestId` records whether the event log currently
  has an active LLM request.
- Put new item types in `feed-items.ts`, add processor support in
  `feed-processors.ts`, and add rendering in `stream-feed.tsx`.
- If a feed item needs provenance, include explicit event fields or raw source
  event data. Do not hide provenance in component state.
