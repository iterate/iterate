# Stream View Slots Exploration

This is deliberately exploratory. It captures directions for the lightweight
stream renderer without making every choice feel final too early.

## Current Pressure

The current clean renderer is already useful because it separates stream
reduction from React rendering, but its language is halfway between two models:

- `CONTEXT.md` says the generic unit is a **Rendered Element**.
- `CONTEXT.md` says named UI regions are **Slots**.
- The current TypeScript still exposes `EventsStreamFeedItem`,
  `EventsStreamHeaderItem`, `EventsStreamViewOutlets`, and
  `state.outlets`.

That gap matters because the next useful UI is not only a feed. The reducer
needs to be able to produce a header status element, feed elements, input
composer affordances, and later maybe a panel or dialog. Those should all be
the same concept: a serializable element with `id`, `type`, and `props`.

## Anchored Model

The least surprising shape is:

```ts
/**
 * Serializable data that selects a known renderer and passes props to it.
 *
 * `id` is stable identity for reconciliation. React renderers pass it through
 * as `key`, but the model is not React-specific.
 */
export type RenderedElement<TProps extends Record<string, unknown> = Record<string, unknown>> = {
  id: string;
  type: string;
  props: TProps;
};

/**
 * Named regions in the stream UI. Each slot contains the same Rendered Element
 * model; placement is not encoded in the element type.
 */
export type StreamViewSlots = {
  header: RenderedElement[];
  feed: RenderedElement[];
  input: RenderedElement[];
};

/**
 * Browser-side projection of an event stream.
 *
 * Reducers own domain interpretation and ordering. Renderers own layout and
 * component selection.
 */
export type StreamViewState = {
  slots: StreamViewSlots;
};
```

This removes per-slot item families from the public model. A feed message and a
header activity chip differ by slot placement and component type, not by being
separate base concepts.

## Prototype A: Built-In Registry Only

Keep the first implementation narrow: every `type` maps to a component shipped
by `packages/ui`.

```ts
/**
 * Known component renderers for stream UI elements.
 *
 * The registry is app-extensible later, but the proof of concept should only
 * use package-owned built-ins so events cannot execute arbitrary browser code.
 */
export type StreamElementRendererRegistry = Record<
  string,
  React.ComponentType<{ element: RenderedElement }>
>;

const renderers = {
  message: MessageElement,
  "raw-event-line": RawEventLineElement,
  "raw-event-group": RawEventGroupElement,
  "raw-json-dump": RawJsonDumpElement,
  "lifecycle-line": LifecycleLineElement,
  "activity-chip": ActivityChipElement,
  "composer-prefill": ComposerPrefillElement,
  "composer-suggestions": ComposerSuggestionsElement,
};
```

Advantages:

- Lowest risk.
- Easy to type with discriminated prop maps later.
- Lets the stream reducer prove header/feed/input composition before extension
  machinery exists.

Cost:

- External processors can only request known UI primitives.
- Any new visual component still needs a deployed frontend change.

Recommended for the next production slice.

## Prototype B: Typed Built-In Prop Map

The model can stay generic while the package exports a typed catalog for known
elements.

```ts
/**
 * Props accepted by built-in stream element renderers.
 *
 * Unknown custom renderers can still use `RenderedElement`, but package-owned
 * reducers should target this map for stronger checks.
 */
export type BuiltInStreamElementPropsByType = {
  message: {
    role: "user" | "assistant";
    text: string;
    timestamp: number;
    raw: Event;
  };
  "raw-event-line": {
    streamPath: StreamPath;
    offset: number;
    eventType: string;
    createdAt: string;
    timestamp: number;
    raw: Event;
  };
  "activity-chip": {
    status: "working";
    label: string;
    detail?: string;
  };
  "composer-prefill": {
    text: string;
    source: "event" | "command";
  };
};

/**
 * Rendered Element constrained to one package-owned built-in type.
 */
export type BuiltInStreamElement<
  TType extends keyof BuiltInStreamElementPropsByType = keyof BuiltInStreamElementPropsByType,
> = {
  id: string;
  type: TType;
  props: BuiltInStreamElementPropsByType[TType];
};
```

Advantages:

- Strong TS for local reducers and renderers.
- Still preserves the conceptual simplicity of one Rendered Element.
- Lets unknown future extension elements sit outside this map.

Cost:

- Generic `RenderedElement` and built-in-specific `BuiltInStreamElement` both
  exist. This is acceptable if the names are crisp.

This is probably the best long-term package shape.

## Prototype C: Slots As Object Snapshot

The reducer returns a full snapshot keyed by slot:

```ts
type StreamViewState = {
  slots: {
    header: RenderedElement[];
    feed: RenderedElement[];
    input: RenderedElement[];
  };
};
```

Advantages:

- React rendering is simple: render a slot by name.
- Replacement-oriented slots are easy. A reducer can set `header` to one
  current activity chip and `input` to one composer hint.
- Whole-stream replay is deterministic.

Cost:

- Every event reduction returns arrays, even if only one element changed.
- Merge/composition rules become important once multiple reducers contribute to
  the same slot.

Recommended for the POC.

## Prototype D: Flat Element Stream With Slot Field

Alternative shape:

```ts
type SlottedRenderedElement = {
  slot: "header" | "feed" | "input";
  element: RenderedElement;
};
```

Advantages:

- A reducer can append one element without knowing the whole slot object.
- Useful for patch streams and incremental transport.

Cost:

- The renderer has to group by slot anyway.
- Slot ownership and ordering become less obvious.
- It encourages "event appends UI" thinking, which fights the current reducer
  model where UI is derived from stream state.

This is useful later for patches, not as the primary in-memory view state.

## Prototype E: Full Snapshot Plus Patch Operations

Keep the reducer snapshot for replay, but allow a transport or incremental
runtime to send operations:

```ts
/**
 * Incremental operation against a slot snapshot.
 *
 * This is a runtime optimization and extension boundary, not the canonical
 * browser-side reduced state.
 */
export type StreamViewPatch =
  | { op: "append"; slot: StreamSlotName; element: RenderedElement }
  | { op: "replace"; slot: StreamSlotName; id: string; element: RenderedElement }
  | { op: "remove"; slot: StreamSlotName; id: string }
  | { op: "reset-slot"; slot: StreamSlotName; elements: RenderedElement[] };
```

Advantages:

- Good for live tool call updates and streaming content.
- Mirrors how Pi-style TUI widgets invalidate/redraw without exposing the
  renderer internals.
- Can eventually let a remote reducer stream UI intent.

Cost:

- More stateful.
- Needs conflict rules.
- Easier to get out of sync than replaying the event log.

Good future layer, but not the first refactor.

## Prototype F: Shelved Reducer Composition

A slot model makes it tempting to run multiple reducers and merge their slots.
That is deliberately shelved. The current direction is two product reducers
with plain helper functions for shared slot projection:

```ts
const rawPrettyStreamViewReducer = { ... };
const rawJsonDumpStreamViewReducer = { ... };

function createSharedSlots(state: SharedProjectionState) {
  return {
    header: createHeaderSlotElements(state),
    input: createInputSlotElements(state),
  };
}
```

This avoids merge rules, ordering rules, and a premature `composeReducers`
helper. Revisit only after the helper-function shape becomes hard to follow.

## Prototype G: Input Slot Semantics

The input slot is trickier than feed/header because it can imply side effects.
Three possible interpretations:

1. **Decorative input slot**: render hints, suggestions, available commands.
2. **Draft request slot**: render an explicit "use this draft" affordance.
3. **Imperative composer slot**: reducer can set the composer text directly.

Recommended first shape: decorative plus explicit affordance. Do not let replay
silently mutate the user's typed draft.

```ts
type ComposerSuggestionProps = {
  label: string;
  text: string;
  sourceEventId: string;
};
```

Later, user actions from these elements can append command/events rather than
calling arbitrary callbacks embedded in props.

## Prototype H: Header Slot Semantics

The header should probably be replacement-oriented:

- current activity
- selected stream identity
- event count
- connection state
- active processor/mode

This argues for stable IDs:

```ts
[
  { id: "stream-title", type: "stream-title", props: { path } },
  { id: "activity", type: "activity-chip", props: { status: "working", detail } },
  { id: "event-count", type: "event-count", props: { count } },
];
```

The reducer can replace `activity` repeatedly without producing feed noise.

## Prototype I: Feed Streaming Updates

Tool calls, assistant generation, and grouped raw events all want "same visual
row updates over time" rather than append-only rows.

Pattern:

- Use event-derived stable IDs where possible.
- Replace the existing element with the same `id`.
- Keep provenance in props when inspection matters.

```ts
{
  id: `tool-call-${toolCallId}`,
  type: "tool-call-card",
  props: {
    status: "running",
    title: "Read file",
    partialOutput,
    sourceOffsets: [12, 13, 14],
  },
}
```

Question for later: should feed be mostly append-only with explicit replacement
exceptions, or should all slots have the same replace-by-id behavior?

## Prototype J: Pi-Style Extension Lessons

The useful lesson from Pi's extension model is not "run arbitrary extension code
in the browser". It is the host-owned UI contract:

- Extensions/plugins emit structured UI intent.
- The host owns layout, focus, rendering, and input dispatch.
- Long-running work can update the same visual component over time.
- Rich UI surfaces include status/header/footer/widgets/overlays, not just the
  transcript.

For Iterate, a safer browser path is:

1. Start with known built-in element types.
2. Let stream events request those element types with serializable props.
3. Validate props by element type.
4. Represent user actions as declared event/command intents, not function props.
5. Consider custom web components only after the built-in registry proves the
   slot model.

Iframe isolation might come back for untrusted custom renderers, but it is not
needed for this proof of concept.

## Recommended POC Path

1. Rename `outlets` to `slots` in the public model and renderer.
2. Introduce `RenderedElement` with `id`, `type`, and `props`.
3. Collapse `HeaderItem`, `PanelItem`, and `InputItem` into generic
   `RenderedElement[]` slots.
4. Keep the current feed item prop shapes, but move those fields under `props`.
5. Keep a compatibility alias only where existing callers need it.
6. Implement a tiny renderer registry for header/feed/input built-ins.
7. Make one reducer populate `header.activity`.
8. Add one synthetic or existing event projection that populates `input` with a
   suggestion, without mutating the composer automatically.
9. Only then consider whether the two-reducer/helper-function shape is still
   too awkward. Do not assume a composition abstraction is needed.

## Strong Bets

- `id` is domain identity, not `reactKey`.
- `type` stays flat. Slot placement lives in `slots`.
- Rendered elements should be serializable and inspectable.
- Reducers should never return React nodes or callbacks.
- Built-in renderers are enough for the first proof of concept.
- Unknown element types should render a visible developer-facing fallback in
  development surfaces, not disappear silently.

## Risk Register

- **Props can become an untyped junk drawer.** Mitigation: export a built-in prop
  map and use it in package-owned reducers.
- **Input slot can accidentally become imperative UI replay.** Mitigation:
  render suggestions/affordances first; require user action to change drafts.
- **Reducer composition can create ordering bugs and premature abstraction.**
  Mitigation: start with two separate reducers and plain helper functions.
- **Event-defined UI can become a security boundary by accident.** Mitigation:
  only allow known renderer types and schema-validated props.
- **Compatibility aliases can fossilize.** Mitigation: document a short-lived
  migration path from `feedItems`/`outlets` to `slots`.

## Questions For Later

1. Are the POC slots exactly `header`, `feed`, and `input`, or should `panel` be
   present but empty from day one?
2. Should `slots` be a fixed object type or a `Record<SlotName, RenderedElement[]>`
   with app-defined slot names?
3. Should feed elements be replace-by-id like header/input elements, or should
   feed be append-only except for explicit grouped/streaming rows?
4. Should reducers return full slot snapshots, patch operations, or full
   snapshots first with patches later?
5. Should renderer ordering be entirely reducer-owned, or should a slot renderer
   sort by a field like `priority`?
6. Should `RenderedElement` have only `id`, `type`, `props`, or also `meta` for
   provenance and diagnostics?
7. Should raw source events live inside `props.raw`, inside `meta.sourceEvents`,
   or outside rendered elements entirely?
8. Should built-in element type names be UI-ish (`activity-chip`) or domain-ish
   (`llm-request-activity`)?
9. Should unknown element types show a visible fallback, log only, or disappear?
10. Should props validation happen at reducer output time, renderer input time,
    or both?
11. Should the app own the renderer registry, or should `packages/ui` own it and
    expose extension hooks?
12. Should future reducer sharing stay as local helper functions, or has it
    earned an exported abstraction? Current answer: local helpers.
13. Should stream view reducers be allowed to read previous rendered elements,
    or should they maintain domain state and derive elements separately?
14. Should header state like "Agent working" be one reducer shared across all
    modes rather than duplicated inside raw/pretty processors?
15. How should multiple reducers merge if they produce the same `slot + id`?
16. Do reducer conflicts fail loudly in development, last-write-wins, or use an
    explicit priority?
17. Should the input slot ever directly prefill the composer, or only render
    suggestions/actions the user can accept?
18. How should user actions from rendered elements be represented: append event,
    run command, navigate, open panel, or some generic action envelope?
19. Should action envelopes be part of `props`, a separate `actions` field, or
    avoided until there is a concrete interaction?
20. What is the smallest event we can append to prove header/feed/input all
    update from one stream replay?
21. Should the current HTML renderer processor path become just another
    `RenderedElement` type, or stay separate because it executes richer code?
22. Should custom web components eventually be registered by package install,
    by stream metadata, or by app configuration?
23. If custom components arrive, do they receive only props, or also a scoped
    action API?
24. Can a future custom renderer open popovers and overlays through host-owned
    slots rather than direct DOM control?
25. Should dialogs/toasts be modeled as slots, patch operations, or imperative
    actions outside the reducer?
26. Should `type` strings be globally namespaced for custom renderers, while
    built-ins stay short?
27. Should built-in `type` strings have a prefix like `core/message`, or does
    that reintroduce placement/name noise?
28. Should the terminal renderer consume the exact same `RenderedElement` model,
    or a terminal-specific projection from the browser model?
29. How much of the Pi-style extension API do we actually want: widgets/status
    surfaces, tool interception, custom commands, or only rich display?
30. What is the deletion plan for `state.feedItems` and `state.outlets` aliases
    once `slots` lands?
