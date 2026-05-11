# Slot Prototype Scenarios

These scenarios are concrete sketches for the next stream renderer refactor.
They are not executable tests yet; they are the examples the tests should
probably become once the model is agreed.

## Shared Sketch Types

```ts
/**
 * Serializable data that chooses a renderer and supplies its props.
 *
 * The field is named `id` because it is model identity. React keys are one
 * renderer use of that identity, not the reason the field exists.
 */
type RenderedElement<TProps extends Record<string, unknown> = Record<string, unknown>> = {
  id: string;
  type: string;
  props: TProps;
};

/**
 * Named regions that the stream view reducer can populate.
 *
 * Slots are layout positions, not element categories. Every slot contains the
 * same Rendered Element model.
 */
type StreamViewSlots = {
  header: RenderedElement[];
  feed: RenderedElement[];
  input: RenderedElement[];
};

/**
 * Complete UI projection for a stream replay.
 *
 * The renderer can render this directly without knowing how events were
 * reduced.
 */
type StreamViewState = {
  slots: StreamViewSlots;
};
```

## Scenario 1: Empty Stream

Input events:

```ts
[];
```

Output:

```ts
{
  slots: {
    header: [],
    feed: [],
    input: [],
  },
}
```

Renderer behavior:

- Header slot renders nothing.
- Feed slot renders the existing empty state.
- Input slot renders only the normal composer.

Question: is the normal composer outside the input slot, with the slot adding
affordances above it, or is the composer itself a built-in Rendered Element?

## Scenario 2: Core Lifecycle Event

Input events:

```ts
[
  {
    offset: 0,
    type: "events.iterate.com/core/stream-first-initialized",
    createdAt: "2026-04-29T12:00:00.000Z",
  },
];
```

Output:

```ts
{
  slots: {
    header: [
      {
        id: "event-count",
        type: "event-count",
        props: { count: 1 },
      },
    ],
    feed: [
      {
        id: "lifecycle-0",
        type: "lifecycle-line",
        props: {
          label: "Stream initialized",
          timestamp: 1777464000000,
          sourceOffset: 0,
        },
      },
    ],
    input: [],
  },
}
```

Interesting choice: `sourceOffset` is in props here. If provenance becomes
generic, this should move to `meta`.

## Scenario 3: LLM Request Activity

Input events:

```ts
[
  {
    offset: 10,
    type: "events.iterate.com/agent/llm-request-requested",
    payload: { requestId: "req_1" },
  },
  {
    offset: 11,
    type: "events.iterate.com/agent/tool-call-started",
    payload: { requestId: "req_1", toolCallId: "tool_1", name: "read" },
  },
];
```

Output:

```ts
{
  slots: {
    header: [
      {
        id: "activity",
        type: "activity-chip",
        props: {
          status: "working",
          label: "Agent working",
          detail: "req_1",
        },
      },
    ],
    feed: [
      {
        id: "tool-call-tool_1",
        type: "tool-call-card",
        props: {
          status: "running",
          title: "read",
          sourceOffsets: [11],
        },
      },
    ],
    input: [],
  },
}
```

Then completion:

```ts
[
  {
    offset: 12,
    type: "events.iterate.com/agent/tool-call-completed",
    payload: { toolCallId: "tool_1", result: "..." },
  },
  {
    offset: 13,
    type: "events.iterate.com/agent/llm-request-completed",
    payload: {
      llmRequestId: 10,
      provider: "cloudflare-ai",
      durationMs: 1000,
      result: { status: "success" },
    },
  },
];
```

Output after replay:

```ts
{
  slots: {
    header: [],
    feed: [
      {
        id: "tool-call-tool_1",
        type: "tool-call-card",
        props: {
          status: "completed",
          title: "read",
          result: "...",
          sourceOffsets: [11, 12],
        },
      },
    ],
    input: [],
  },
}
```

This demonstrates replacement by `id`: the tool card stays one feed row while
its props evolve.

## Scenario 4: Input Suggestion

Input event:

```ts
{
  offset: 20,
  type: "events.iterate.com/agent/suggested-reply-created",
  payload: {
    suggestionId: "sg_1",
    text: "Can you show the failing logs?",
  },
}
```

Output:

```ts
{
  slots: {
    header: [],
    feed: [],
    input: [
      {
        id: "suggested-reply-sg_1",
        type: "composer-suggestion",
        props: {
          text: "Can you show the failing logs?",
          acceptAction: {
            type: "prefill-composer",
            text: "Can you show the failing logs?",
          },
        },
      },
    ],
  },
}
```

Important boundary: the reducer did not mutate the composer text. It rendered a
suggestion with an explicit action.

Question: should `acceptAction` live in props, or should actions be a sibling
field on `RenderedElement`?

## Scenario 5: Stream Metadata As Header And Feed

Input event:

```ts
{
  offset: 30,
  type: "events.iterate.com/core/metadata-updated",
  payload: {
    metadata: {
      title: "Deploy investigation",
      priority: "high",
    },
  },
}
```

Output:

```ts
{
  slots: {
    header: [
      {
        id: "stream-title",
        type: "stream-title",
        props: { title: "Deploy investigation" },
      },
      {
        id: "stream-priority",
        type: "status-pill",
        props: { label: "high", tone: "warning" },
      },
    ],
    feed: [
      {
        id: "metadata-updated-30",
        type: "metadata-updated-card",
        props: {
          metadata: {
            title: "Deploy investigation",
            priority: "high",
          },
          sourceOffset: 30,
        },
      },
    ],
    input: [],
  },
}
```

Same event, two slots. The header gets replacement-oriented current state; the
feed gets append-oriented audit history.

## Scenario 6: Raw + Pretty Mode Without Composition

Do not introduce a generic reducer composer for this. Raw+pretty is the default
product reducer: each event creates one raw summary feed item and may also
create one semantic feed item.

```ts
function reduceEventToRawPrettyFeedElements(event: Event) {
  return [toRawEventElement(event), ...reduceEventToSemanticFeedElements(event)];
}
```

This is less clever, preserves per-event locality, and keeps the UI centered on
two product modes: raw-pretty and raw single JSON/YAML dump.

## Scenario 7: Terminal Renderer Consuming Same Model

Same state:

```ts
{
  slots: {
    header: [{ id: "activity", type: "activity-chip", props: { label: "Agent working" } }],
    feed: [{ id: "message-1", type: "message", props: { role: "assistant", text: "Done" } }],
    input: [{ id: "suggestion-1", type: "composer-suggestion", props: { text: "Run tests" } }],
  },
}
```

Web renderer:

- Header chip.
- Chat-style assistant message.
- Suggestion row above composer.

Terminal renderer:

- Header status line.
- Plain assistant text block.
- Slash-style suggestion row above prompt.

This argues for keeping Rendered Element props semantic enough that a terminal
renderer can make its own visual choices.

## Scenario 8: Unknown Element Type

Input state:

```ts
{
  slots: {
    feed: [
      {
        id: "custom-1",
        type: "vendor/fancy-widget",
        props: { value: 42 },
      },
    ],
    header: [],
    input: [],
  },
}
```

Development fallback:

```text
Unknown stream element: vendor/fancy-widget
id: custom-1
props: { value: 42 }
```

Production fallback options:

- Render compact "Unsupported element" with inspectable JSON.
- Hide it but log.
- Render raw JSON only in debug modes.

Recommendation: visible compact fallback in development and internal tools;
quiet fallback only for customer-facing surfaces.

## Scenario 9: Minimal Implementation Migration

Current:

```ts
{
  outlets: {
    feed: [{ type: "message", id: "message-user-1", role: "user", text: "hi" }],
    header: [{ type: "activity", id: "activity", label: "Agent working" }],
    panels: [],
    input: [],
  },
}
```

Target:

```ts
{
  slots: {
    feed: [
      {
        type: "message",
        id: "message-user-1",
        props: { role: "user", text: "hi" },
      },
    ],
    header: [
      {
        type: "activity-chip",
        id: "activity",
        props: { label: "Agent working" },
      },
    ],
    input: [],
  },
}
```

Migration plan:

1. Add `slots` while keeping `outlets` as a compatibility alias.
2. Move renderer reads from `viewState.outlets` to `viewState.slots`.
3. Move feed renderer switches from top-level fields to `item.props`.
4. Delete per-slot item base types.
5. Delete `outlets` and `feedItems` aliases once agents/events callers are on
   `slots`.
