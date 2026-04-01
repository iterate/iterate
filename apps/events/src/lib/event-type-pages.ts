import { type JSONObject, type EventType } from "@iterate-com/events-contract";

export type EventTypePageDefinition = {
  readonly slug: string;
  readonly href: `/${string}/`;
  readonly title: string;
  readonly type: EventType;
  readonly summary: string;
  readonly payloadExample?: JSONObject;
  readonly details?: readonly string[];
};

export const streamCreatedPage = {
  slug: "stream-created",
  href: "/stream-created/",
  title: "Stream Created",
  type: "https://events.iterate.com/events/stream/created",
  summary:
    "Internal meta event emitted when a stream initializes itself and when descendant stream creation is propagated upward.",
  payloadExample: {
    path: "/demo/stream",
  },
  details: [
    "Every initialized stream writes its own self-created event at offset 0 before any caller-appended events.",
    "The same event type also appears on parent streams to advertise newly created descendants.",
    "It is useful for stream discovery and lightweight operational tooling.",
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

export const errorOccurredPage = {
  slug: "error-occurred",
  href: "/error-occurred/",
  title: "Error Occurred",
  type: "https://events.iterate.com/events/error-occurred",
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
  errorOccurredPage,
  manualEventAppendedPage,
  streamCreatedPage,
  streamMetadataUpdatedPage,
] as const satisfies readonly EventTypePageDefinition[];

export function getEventTypePageByType(type: string) {
  return eventTypePages.find((page) => page.type === type);
}
