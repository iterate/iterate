import {
  STREAM_CREATED_TYPE,
  STREAM_METADATA_UPDATED_TYPE,
  type JSONObject,
  type EventType,
} from "@iterate-com/events-contract";

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
  type: STREAM_CREATED_TYPE,
  summary: "Internal meta event emitted when a stream path is first created by an append.",
  payloadExample: {
    path: "/demo/stream",
  },
  details: [
    "The stream appends this automatically the first time a path is written to.",
    "It is useful for stream discovery and lightweight operational tooling.",
  ],
} satisfies EventTypePageDefinition;

export const streamMetadataUpdatedPage = {
  slug: "stream-metadata-updated",
  href: "/stream-metadata-updated/",
  title: "Stream Metadata Updated",
  type: STREAM_METADATA_UPDATED_TYPE,
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
  manualEventAppendedPage,
  streamCreatedPage,
  streamMetadataUpdatedPage,
] as const satisfies readonly EventTypePageDefinition[];

export function getEventTypePageByType(type: string) {
  return eventTypePages.find((page) => page.type === type);
}
