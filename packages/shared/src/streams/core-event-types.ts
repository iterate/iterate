export const CORE_EVENT_TYPE_PREFIX = "events.iterate.com/core/" as const;

function coreEventType<const Slug extends string>(slug: Slug) {
  return `${CORE_EVENT_TYPE_PREFIX}${slug}` as const;
}

export const STREAM_FIRST_INITIALIZED_TYPE = coreEventType("stream-first-initialized");
export const STREAM_DURABLE_OBJECT_WOKE_UP_TYPE = coreEventType("durable-object-woke-up");
export const STREAM_CHILD_STREAM_CREATED_TYPE = coreEventType("child-stream-created");
export const STREAM_METADATA_UPDATED_TYPE = coreEventType("metadata-updated");
export const STREAM_ERROR_OCCURRED_TYPE = coreEventType("error-occurred");
export const STREAM_INVALID_EVENT_APPENDED_TYPE = coreEventType("invalid-event-appended");
export const STREAM_SUBSCRIPTION_CONFIGURED_TYPE = coreEventType("subscription-configured");
export const STREAM_CIRCUIT_BREAKER_CONFIGURED_TYPE = coreEventType("circuit-breaker-configured");
export const STREAM_HTML_RENDERER_CONFIGURED_TYPE = coreEventType("html-renderer-configured");
export const STREAM_PAUSED_TYPE = coreEventType("paused");
export const STREAM_RESUMED_TYPE = coreEventType("resumed");

export function getCoreEventTypeSlug(type: string) {
  if (!type.startsWith(CORE_EVENT_TYPE_PREFIX)) {
    return null;
  }

  return type.slice(CORE_EVENT_TYPE_PREFIX.length);
}

export function isCoreEventType(type: string) {
  return getCoreEventTypeSlug(type) != null;
}
