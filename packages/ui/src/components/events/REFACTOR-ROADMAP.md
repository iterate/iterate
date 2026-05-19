# Stream Renderer Refactor Roadmap

This is the practical gap analysis between the current lightweight renderer and
the slot-based Rendered Element model described in `CONTEXT.md`.

## Status

The first production slice is implemented:

- `feed-items.ts` now exports `EventsStreamRenderedElement`,
  `EventsStreamSlots`, and built-in element prop types.
- `EventsStreamViewState.slots` is the canonical render surface.
- Built-in element-specific data now lives under `element.props`.
- The web renderer reads `viewState.slots`.
- The Events app renders input-slot suggestions above the composer in the clean
  view.
- The OpenTUI proof of concept reads `state.slots.feed`.
- `outlets`, `feedItems`, and old `*FeedItem` type aliases remain only as
  deprecated migration affordances.

## Target

The browser-side stream reducer should produce one view state:

```ts
{
  slots: {
    header: RenderedElement[];
    feed: RenderedElement[];
    input: RenderedElement[];
  },
}
```

Every rendered unit should have:

```ts
{
  id: string;
  type: string;
  props: Record<string, unknown>;
}
```

The renderer should choose a known component from `type`, pass `props`, and use
`id` for stable identity.

## Remaining Gap

### `feed-items.ts`

Current shape:

- Generic Rendered Elements and slots are in place.
- Built-in element prop types preserve type safety for package-owned renderers.
- `composer-suggestion` is the first input-slot element.
- Deprecated compatibility aliases still exist for old feed item names.
- `outlets` and `feedItems` still exist on `EventsStreamViewState` as aliases.

Remaining work:

- Delete compatibility aliases after downstream code no longer imports them.
- Consider renaming `feed-items.ts` to `stream-view-model.ts`.

Priority: medium. The core model boundary is now in place.

### `feed-processors.ts`

Current shape:

- Helpers build `slots`.
- Feed reducers return built-in Rendered Elements.
- Header activity is bolted onto every processor through
  `createHeaderSlotElements`.
- Stream errors project to the input slot through `createInputSlotElements`.
- Raw/pretty mode is one processor that interleaves raw and semantic feed items.

Remaining work:

- Keep activity and input projection as helper functions for now.
- Revisit structure only if these helper functions become hard to follow.

Priority: medium. Runtime behavior is stable; the next design step is reducing
mode/reducer sprawl, not adding composition infrastructure.

### `stream-feed.tsx`

Current shape:

- Reads `viewState.slots.header` and `viewState.slots.feed`.
- Renders built-in Rendered Elements by `element.type`.
- Reads component-specific data from `element.props`.
- Exports `EventsStreamInputSlot` for composer-adjacent slot rendering.
- Has separate header, feed, and input renderer switches.

Remaining work:

- Render `viewState.slots.input` near a composer once that surface exists here.
- Consider extracting the renderer registry from the component file if it grows.

Priority: medium. Header/feed now prove the unified model.

### `apps/events/src/components/stream-page.tsx`

Current shape:

- Passes `viewState` to `EventsStreamView`.
- Should not need much change if compatibility is preserved.

Desired shape:

- No app-local knowledge of feed item families.
- App chooses processor/mode and renders the view.

Priority: low unless type exports change without compatibility.

## Implementation Slices

### Slice 1: Add `slots` Without Moving Props

Status: done, with `outlets` kept as a deprecated alias.

Verification run:

- `pnpm --filter @iterate-com/ui typecheck`
- `pnpm --filter @iterate-com/events typecheck`

### Slice 2: Collapse Per-Slot Base Types

Status: done for the public model. `header`, `feed`, and `input` slots now all
contain the same built-in Rendered Element union.

Remaining work: delete deprecated old feed item aliases after downstream code
has fully moved to element names.

### Slice 3: Move Item Fields Under `props`

Status: done for built-in elements, web renderer, processors, and terminal feed
formatting.

Remaining work: add focused tests around grouped raw events if this becomes a
heavily edited path.

### Slice 4: Input Slot Proof

Status: done for the first proof. Stream error events now produce a
`composer-suggestion` input element, and the Events app can accept it to prefill
the agent composer.

Remaining work:

- Decide whether input-slot actions should stay inside `props` or move to a
  top-level `actions` field.
- Add a browser/spec check once this becomes a committed UX.

### Slice 5: Two Product Reducers, Plain Helpers

Goal: reduce the current mode sprawl without introducing a composition
abstraction.

Steps:

1. Keep two product reducers: default raw-pretty and raw single JSON/YAML dump.
2. Move shared behavior into plain helper functions, such as activity header and
   input suggestion projection.
3. Treat raw-only and pretty-only as debugging helpers or delete them once the
   UI no longer exposes those modes.

Risk: low-medium. The shape stays simple, but the UI mode surface may need a
product decision.

Do not add a generic `composeReducers` helper in this slice.

## Preferred Order

1. Done: model rename to `slots`.
2. Done: generic Rendered Element arrays in all slots.
3. Done: `props` envelope.
4. Done: built-in renderer dispatch and unknown fallback.
5. Done: input slot proof.
6. Next: simplify toward the two product reducers with shared helper functions.
7. Later: custom renderer exploration.

This order keeps behavior stable while moving the shared model toward the shape
needed for richer UI.

## Names Still Worth Revisiting

- `type: "activity"` vs `type: "activity-chip"`.
- `type: "raw-event"` vs `type: "raw-event-line"`.

## Possible File Rename

`feed-items.ts` is increasingly the wrong name. Once the generic model lands,
consider:

- `rendered-elements.ts`
- `stream-view-state.ts`
- `stream-view-model.ts`

Recommended: `stream-view-model.ts`, because it can contain `RenderedElement`,
slots, processor/reducer types, and built-in prop maps without implying a
specific slot.
