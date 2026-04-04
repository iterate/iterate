import { type EventType, type JSONObject } from "@iterate-com/events-contract";

export type EventTypePageDefinition = {
  readonly slug: string;
  readonly href: `/${string}/`;
  readonly title: string;
  readonly type: EventType;
  readonly summary: string;
  readonly payloadExample?: JSONObject;
  readonly details?: readonly string[];
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
    "Every initialized stream writes its own self-initialized event at offset 0 before any caller-appended events.",
    "Parent/root discovery uses a separate built-in child-stream-created event.",
    "It is useful for reasoning about a stream's own lifecycle and offset invariants.",
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
    path: "/demo/stream/child",
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
  errorOccurredPage,
  manualEventAppendedPage,
  streamInitializedPage,
  streamMetadataUpdatedPage,
] as const satisfies readonly EventTypePageDefinition[];

export function getEventTypePageByType(type: string) {
  return eventTypePages.find((page) => page.type === type);
}
