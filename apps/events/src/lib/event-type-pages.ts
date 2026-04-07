import { type EventInput, type EventType, type JSONObject } from "@iterate-com/events-contract";

export type EventTypePageDefinition = {
  readonly slug: string;
  readonly href: `/${string}/`;
  readonly title: string;
  readonly type: EventType;
  readonly summary: string;
  readonly payloadExample?: JSONObject;
  readonly templates?: readonly EventInputTemplateDefinition[];
  readonly details?: readonly string[];
};

export type EventInputTemplateDefinition = {
  readonly id: string;
  readonly label: string;
  readonly event: EventInput;
};

export const streamInitializedPage = {
  slug: "stream-initialized",
  href: "/stream-initialized/",
  title: "Stream Initialized",
  type: "https://events.iterate.com/events/stream/initialized",
  summary: "Internal meta event emitted exactly once when a stream initializes itself.",
  payloadExample: {
    projectSlug: "public",
    path: "/demo/stream",
  },
  details: [
    "Every initialized stream writes its own self-initialized event at offset 1 before any caller-appended events.",
    "Parent/root discovery uses a separate built-in child-stream-created event.",
    "It is useful for reasoning about a stream's own lifecycle and offset invariants.",
  ],
} satisfies EventTypePageDefinition;

export const streamDurableObjectConstructedPage = {
  slug: "stream-durable-object-constructed",
  href: "/stream-durable-object-constructed/",
  title: "Stream Durable Object Constructed",
  type: "https://events.iterate.com/events/stream/durable-object-constructed",
  summary:
    "Internal meta event emitted when a previously initialized stream durable object wakes and reconstructs itself from persisted state.",
  payloadExample: {},
  details: [
    "This only appears after the durable object constructor rehydrates an already initialized stream from SQLite state.",
    "Fresh streams do not emit it on first initialize because there is no prior reduced state to rehydrate.",
    "It is useful when debugging durable object cold starts, hibernation, and resume behavior.",
  ],
} satisfies EventTypePageDefinition;

export const streamMetadataUpdatedPage = {
  slug: "stream-metadata-updated",
  href: "/stream-metadata-updated/",
  title: "Stream Metadata Updated",
  type: "https://events.iterate.com/events/stream/metadata-updated",
  summary: "Internal metadata event that replaces the reduced metadata snapshot for a stream.",
  payloadExample: {
    metadata: {
      owner: "demo",
      environment: "dev",
    },
  },
  details: [
    "The reducer treats this payload as a full metadata replacement rather than a patch merge.",
    "Use it when stream-level metadata should change without inventing a separate mutation API.",
  ],
} satisfies EventTypePageDefinition;

export const childStreamCreatedPage = {
  slug: "child-stream-created",
  href: "/child-stream-created/",
  title: "Child Stream Created",
  type: "https://events.iterate.com/events/stream/child-stream-created",
  summary:
    "Built-in event propagated to a parent stream when a new child stream is initialized beneath it.",
  payloadExample: {
    childPath: "/demo/stream/child",
  },
  details: [
    "When a nested stream initializes, the system appends this event to each ancestor stream in the path hierarchy.",
    "Only the first append to a child stream triggers propagation — subsequent appends do not repeat it.",
  ],
} satisfies EventTypePageDefinition;

export const errorOccurredPage = {
  slug: "error-occurred",
  href: "/error-occurred/",
  title: "Error Occurred",
  type: "https://events.iterate.com/events/stream/error-occurred",
  summary: "Built-in error event for recording failures directly in a stream.",
  payloadExample: {
    message: "Failed to fetch remote state",
  },
  details: [
    "Use this when a stream should record an operational failure as an event instead of only logging it.",
    "The built-in payload shape only requires a human-readable message.",
  ],
} satisfies EventTypePageDefinition;

export const jsonataTransformerConfiguredPage = {
  slug: "jsonata-transformer-configured",
  href: "/jsonata-transformer-configured/",
  title: "JSONata Transformer Configured",
  type: "https://events.iterate.com/events/stream/jsonata-transformer-configured",
  summary:
    "Built-in control event that registers or replaces an append-time JSONata transformer by slug.",
  payloadExample: {
    slug: "normalize-webhook",
    matcher: "type = 'webhook.raw'",
    transform: '{"type":"webhook.normalized","payload":{"body":payload}}',
  },
  details: [
    "The latest configured event for a slug replaces the previous matcher and transform.",
    "Transformers evaluate against the full committed event envelope, not just payload.",
  ],
  templates: [
    {
      id: "jsonata-transformer-configured:slack-webhook",
      label: "JSONata Transformer Configured · Slack webhook",
      event: {
        type: "https://events.iterate.com/events/stream/jsonata-transformer-configured",
        payload: {
          slug: "slack-webhook",
          matcher:
            "type = 'https://events.iterate.com/events/stream/invalid-event-appended' and payload.rawInput.command = '/iterate'",
          transform: `{
  "type":"https://events.iterate.com/events/example/slack-webhook-received",
  "payload":{
    "teamId":payload.rawInput.team_id,
    "channelId":payload.rawInput.channel_id,
    "userId":payload.rawInput.user_id,
    "command":payload.rawInput.command,
    "text":payload.rawInput.text
  },
  "metadata":{
    "source":"slack-webhook",
    "teamDomain":payload.rawInput.team_domain
  }
}`,
        },
      },
    },
  ],
} satisfies EventTypePageDefinition;

const pingPongDynamicWorkerTemplateScript = `
function containsPing(event) {
  if (event.type === "https://events.iterate.com/events/stream/dynamic-worker/configured") {
    return false;
  }

  return /\\bping\\b/i.test(
    JSON.stringify({
      type: event.type,
      payload: event.payload,
      metadata: event.metadata ?? null,
    }),
  );
}

export default {
  initialState: {},

  reduce(state) {
    return state;
  },

  async onEvent({ append, event }) {
    if (!containsPing(event)) {
      return;
    }

    await append({ type: "pong" });
  },
};
`.trim();

export const dynamicWorkerConfiguredPage = {
  slug: "dynamic-worker-configured",
  href: "/dynamic-worker-configured/",
  title: "Dynamic Worker Configured",
  type: "https://events.iterate.com/events/stream/dynamic-worker/configured",
  summary:
    "Built-in control event that registers or replaces a dynamic worker processor by slug for a stream.",
  payloadExample: {
    slug: "ping-pong",
    script: pingPongDynamicWorkerTemplateScript,
  },
  details: [
    "The latest configured event for a slug replaces the previous dynamic worker runtime for that slug on the same stream.",
    "The raw composer template uses `script` directly so it is copy-pastable without any bundling or dependencies.",
    'This trivial example replies with `{ type: "pong" }` whenever a later event contains the word `ping`.',
  ],
  templates: [
    {
      id: "dynamic-worker-configured:ping-pong",
      label: "Dynamic Worker Configured · Ping pong",
      event: {
        type: "https://events.iterate.com/events/stream/dynamic-worker/configured",
        payload: {
          slug: "ping-pong",
          script: pingPongDynamicWorkerTemplateScript,
        },
      },
    },
  ],
} satisfies EventTypePageDefinition;

export const streamPausedPage = {
  slug: "stream-paused",
  href: "/stream-paused/",
  title: "Stream Paused",
  type: "https://events.iterate.com/events/stream/paused",
  summary: "Built-in control event that marks a stream as temporarily rejecting new events.",
  payloadExample: {
    reason: "circuit breaker tripped: 100 events in under 1 second",
  },
  details: [
    "While paused, the durable object rejects all new appends except `stream/resumed`.",
    "The circuit breaker processor can emit this event automatically.",
  ],
  templates: [
    {
      id: "stream-paused:manual-pause",
      label: "Stream Paused · Manual pause",
      event: {
        type: "https://events.iterate.com/events/stream/paused",
        payload: {
          reason: "operator paused stream during incident triage",
        },
      },
    },
    {
      id: "stream-paused:circuit-breaker",
      label: "Stream Paused · Circuit breaker trip",
      event: {
        type: "https://events.iterate.com/events/stream/paused",
        payload: {
          reason: "circuit breaker tripped: 100 events in under 1 second",
        },
      },
    },
  ],
} satisfies EventTypePageDefinition;

export const streamResumedPage = {
  slug: "stream-resumed",
  href: "/stream-resumed/",
  title: "Stream Resumed",
  type: "https://events.iterate.com/events/stream/resumed",
  summary: "Built-in control event that re-opens a paused stream for new appends.",
  payloadExample: {
    reason: "operator override",
  },
  details: [
    "This is the only event type allowed through while a stream is paused.",
    "Resuming clears the active paused state so normal appends can continue.",
  ],
  templates: [
    {
      id: "stream-resumed:operator-override",
      label: "Stream Resumed · Operator override",
      event: {
        type: "https://events.iterate.com/events/stream/resumed",
        payload: {
          reason: "operator override after inspection",
        },
      },
    },
    {
      id: "stream-resumed:traffic-normalized",
      label: "Stream Resumed · Traffic normalized",
      event: {
        type: "https://events.iterate.com/events/stream/resumed",
        payload: {
          reason: "traffic normalized after the burst subsided",
        },
      },
    },
  ],
} satisfies EventTypePageDefinition;

export const manualEventAppendedPage = {
  slug: "manual-event-appended",
  href: "/manual-event-appended/",
  title: "Manual Event Appended",
  type: "https://events.iterate.com/manual-event-appended",
  summary:
    "Small hand-written example event for trying the UI and proving that an event type can have its own real page route.",
  payloadExample: {
    message: "hello",
  },
  details: [
    "Use this as the copy-paste template when you want to add another event type page.",
    "The route slug can stay short and human-readable even when the full event type is a longer URL.",
  ],
} satisfies EventTypePageDefinition;

export const eventTypePages = [
  childStreamCreatedPage,
  dynamicWorkerConfiguredPage,
  errorOccurredPage,
  jsonataTransformerConfiguredPage,
  manualEventAppendedPage,
  streamDurableObjectConstructedPage,
  streamInitializedPage,
  streamMetadataUpdatedPage,
  streamPausedPage,
  streamResumedPage,
] as const satisfies readonly EventTypePageDefinition[];

export function getEventTypePageByType(type: string) {
  return eventTypePages.find((page) => page.type === type);
}

export const eventInputTemplates = (eventTypePages as readonly EventTypePageDefinition[]).flatMap(
  (page) => [
    {
      id: `${page.slug}:default`,
      label: page.title,
      event: {
        type: page.type,
        payload: page.payloadExample ?? {},
      } satisfies JSONObject,
    },
    ...(page.templates ?? []),
  ],
) satisfies readonly EventInputTemplateDefinition[];

export function getEventInputTemplateById(id: string) {
  return eventInputTemplates.find((template) => template.id === id);
}
