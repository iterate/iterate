# Events Stream View Components

This directory is the clean-room implementation for rendering an events stream.

The core idea is intentionally small:

1. Start with raw `Event[]` from the events oRPC client.
2. The stream-view processor synchronously reduces every event into one
   mode-agnostic view state.
3. The host filters that state for the selected renderer mode.
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
- `SLOT-PROTOTYPES.md` sketches concrete event-to-slot snapshots that can later
  become tests.
- `feed-items.ts` defines `EventsStreamRenderedElement`, built-in element prop
  types, `EventsStreamSlots`, and the reduced stream view state.
- `stream-view-processor/contract.ts` defines `StreamViewProcessorContract`,
  the consumes-all stream processor whose reducer projects raw events into the
  view state, plus the `reduceStreamViewEvents` batch helper.
- `feed-processors.ts` defines the renderer-mode constants and dropdown
  options (`eventsStreamRendererModes`).
- `feed-element-renderers/` holds the per-element React renderers (message
  card, agent output card, grouped raw event line, ...).
- `stream-layout.tsx` defines the package-owned header/main/message-input
  layout regions for browser stream UIs.
- `stream-feed.tsx` renders the stream view and feed items by `item.type`.
- `event-inspector-sheet.tsx` renders the shared raw event detail drawer.

## Reducer and renderer modes

There is one reducer: `StreamViewProcessorContract` in
`stream-view-processor/contract.ts`. It follows the same reducer discipline as
the other stream processor contracts (`defineProcessorContract` plus a pure
`reduce({ event, state })`), consumes ALL events (`consumesAllEvents`), and
always produces both raw summary elements and semantic elements. Consecutive
events without a semantic renderer collapse into a grouped raw summary, but
the group keeps every raw event for inspector navigation.

Renderer modes are pure view-time filters over that one state, not separate
reducers. `feed-processors.ts` defines the modes (`raw-pretty` default,
`pretty`, `raw-single-json`) and the dropdown options; the host app applies
the filter (see `applyRendererMode` in `apps/os`'s `project-stream-view.tsx`).

The reducer also makes small cross-slot projections:

- event counts become an `event-counter` element in the header slot.
- active LLM requests become an `activity` element in the header slot.
- stream error events become a `composer-suggestion` element in the input slot.

## Renderers

Renderers are deliberately broader than any one view. It is fine for a renderer
to exist even when the selected processor never emits that item type.

Do not make renderer selection depend on the dropdown mode. The mode filters
the view state; `item.type` selects the renderer.

This directory currently has a web renderer in `stream-feed.tsx`. That is the
intended split: processors and feed item data are shared; renderers belong to
each UI runtime.

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
- Input-slot elements should render affordances or explicit actions. They should
  not directly mutate a composer during event replay.
- Put new item types in `feed-items.ts`, add reducer support in
  `stream-view-processor/contract.ts`, and add rendering in `stream-feed.tsx`.
- If a Rendered Element needs provenance, include explicit event fields or raw
  source event data. Do not hide provenance in component state.
