---
state: todo
priority: high
size: large
dependsOn:
---

# Shared stream UI SDK

This task captures the proposed shape for exporting the stream browsing UI from `apps/events` so it can be reused both:

- inside `apps/events` itself
- inside simpler host apps like `ai-engineer-workshop/jonas/web`

This is a proposal/spec task only. It is intentionally **not** implementation work yet.

## goal

Export reusable stream UI from `apps/events` without forcing host apps to adopt:

- the `apps/events` route tree
- the `apps/events` sidebar/header chrome
- the `apps/events` singleton oRPC/query helpers
- the exact built-in pretty-feed semantics from the current app

The reusable boundary should be flexible enough for a host app to provide its own event semantics and React renderers per mounted detail view.

## core design

The public shape should be:

1. a small host-owned data boundary
2. a reusable stream list component
3. a reusable stream detail component

More concretely:

- host app owns `QueryClientProvider`
- shared SDK owns a small `EventsSdkProvider` for transport/client wiring only
- shared SDK exports `StreamsNavigator`
- shared SDK exports `StreamDetailView`

Important TanStack-aligned constraint:

- the shared layer should **not** create a global `QueryClient`
- each host app should create/provide its own query client at the app/request boundary

## what stays app-specific

These concerns should stay in `apps/events` route/layout adapters:

- URL pathname conventions like `/streams/$`
- search-param ownership for `renderer` and `event`
- breadcrumbs
- header actions
- sidebar selection and shell layout

That means `apps/events` should keep thin wrappers around the reusable components instead of exporting the current `StreamsSidebar` and `StreamPage` as-is.

## proposed exported surface

### `EventsSdkProvider`

This provider should stay narrow.

Its job is to provide the events transport/client that shared hooks/components use.

It should **not** be where pretty-feed semantics are registered.

Roughly:

```ts
type EventsClient = {
  listStreams(input: {}): Promise<Array<{ path: StreamPath; createdAt: string }>>;
  getState(input: { streamPath: StreamPath }): Promise<StreamState>;
  append(input: { path: StreamPath; events: EventInput[] }): Promise<{
    created: boolean;
    events: Event[];
  }>;
  stream(
    input: { path: StreamPath; offset?: string; live?: boolean },
    options?: { signal?: AbortSignal },
  ): Promise<AsyncIterable<Event>>;
};

type EventsSdkProviderProps = {
  client: EventsClient;
  children: React.ReactNode;
};
```

### `StreamsNavigator`

This should be route-agnostic and mostly presentational/data-driven.

It should own:

- querying `listStreams`
- local filter text
- optional create/open-stream affordance

It should not own concrete route navigation.

Roughly:

```ts
type StreamsNavigatorProps = {
  selectedStreamPath?: StreamPath | null;
  onSelectStream: (path: StreamPath) => void;
  onCreateStream?: (path: StreamPath) => void;
  createLabel?: string;
};
```

`apps/events` can pass router navigation callbacks.

The workshop app can pass local-state or router callbacks of its own.

### `StreamDetailView`

This is the main extension surface.

It should own:

- `getState`
- live stream subscription
- append composer
- raw event inspector
- pretty/raw/raw+pretty display modes

It should accept per-instance semantic customization through separate reducer and renderer props.

Roughly:

```ts
type StreamDetailViewProps = {
  streamPath: StreamPath;
  rendererMode?: StreamRendererMode;
  openEventOffset?: string;
  onOpenEventOffsetChange?: (offset?: string) => void;
  metadataOpen?: boolean;
  onMetadataOpenChange?: (open: boolean) => void;

  prettyReducers?: StreamPrettyReducer[];
  prettyRenderers?: StreamPrettyRenderers;
  eventTypes?: StreamEventTypeDefinition[];

  includeDefaultPrettyReducers?: boolean;
  includeDefaultPrettyRenderers?: boolean;
  includeDefaultEventTypes?: boolean;
};
```

## reducer/renderer model

The public API should **not** require a bundled "plugin" concept.

Instead:

- reducers and renderers are passed independently
- reducers emit plain semantic items tagged by `kind`
- renderers are React components looked up by `kind`

This fits the current code better, because the app already has:

- projection logic in `src/lib/stream-feed-projection.ts`
- renderer switching in `src/components/stream-event-feed.tsx`
- event-type metadata in `src/lib/event-type-pages.ts`

So the proposed SDK is an evolution of the current split, not a totally new mental model.

### reducers

The custom reducers discussed here are **client-side pretty-feed reducers only**.

They do **not** change the authoritative durable-object `getState()` result.

That server-side reduced shape should stay owned by the stream DO.

Reducers should be stateful and able to emit zero/many semantic items over time.

Roughly:

```ts
type PrettyFeedItem = {
  kind: string;
  key: string;
  timestamp: number;
  sourceOffsets: string[];
  data: unknown;
};

type StreamPrettyReducer<TState = unknown> = {
  id: string;
  initialState: TState;
  reduce: (
    state: TState,
    event: Event,
  ) => {
    state: TState;
    emit?: PrettyFeedItem | PrettyFeedItem[];
  };
};
```

### renderers

Custom pretty renderers **can and should** be React components/functions.

That is likely the cleanest sweet spot:

- host apps can pass real React components
- components can use hooks
- reduced feed items stay plain data

Roughly:

```ts
type StreamPrettyRendererProps = {
  item: PrettyFeedItem;
  streamPath: StreamPath;
  openEventOffset?: string;
  onOpenEventOffsetChange?: (offset?: string) => void;
};

type StreamPrettyRenderers = Record<string, React.ComponentType<StreamPrettyRendererProps>>;
```

Important design choice:

- React components should be passed in as renderers
- React components should **not** live inside the reduced feed items/state themselves

## event type metadata

Event-type metadata for the append composer and inspector should remain a separate concept from pretty reducers/renderers.

Roughly:

```ts
type StreamEventTypeDefinition = {
  type: EventType;
  title: string;
  href?: string;
  payloadExample?: JSONObject;
};
```

This should let the workshop app provide different event templates/docs links without having to replace the entire pretty-feed pipeline.

## how this maps to current code

The current app already has the right raw ingredients:

- `src/components/streams-sidebar.tsx`
- `src/components/stream-page.tsx`
- `src/components/stream-event-feed.tsx`
- `src/lib/stream-feed-projection.ts`
- `src/lib/stream-feed-types.ts`
- `src/lib/event-type-pages.ts`
- `src/hooks/use-live-stream-events.ts`

The refactor would mostly be:

1. move transport-dependent shared behavior behind `EventsSdkProvider`
2. extract route-agnostic list/detail components
3. replace hardcoded pretty projection/rendering with reducer + renderer props
4. keep `apps/events` route/search/chrome wrappers thin and app-specific

## non-goals

- no host-defined reducers for the authoritative durable-object state
- no attempt to make the shared layer own route search params
- no requirement that all semantics be registered globally at provider level
- no public plugin abstraction unless implementation later proves it necessary internally

## open questions before implementation

- should `StreamsNavigator` own the "create stream" form UI, or should that be host-supplied too?
- should `StreamDetailView` merge defaults and overrides by default, or should hosts choose one mode explicitly?
- should the pretty reducer output support richer grouping/ordering metadata beyond `timestamp` and `sourceOffsets`?
- how much of the current built-in `message` / `tool` / `error` feed model should remain first-class versus being re-expressed as reducers + renderers?

## implementation sketch

If this task is accepted later, the likely shape is:

1. create `src/sdk/` inside `apps/events`
2. export the SDK from `@iterate-com/events`
3. refactor `apps/events` to consume its own shared SDK through route adapters
4. add React Query + SDK wiring in `ai-engineer-workshop/jonas/web`
5. prove that the workshop app can pass custom pretty reducers/renderers per `StreamDetailView` instance
