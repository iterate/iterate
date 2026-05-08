/**
 * Reads arbitrary event payloads emitted by CodemodeSession and MCP sessions.
 *
 * Event payloads cross worker and Durable Object boundaries, so consumers must
 * treat them as untrusted JSON instead of assuming the generated Event type has
 * already narrowed the runtime shape.
 */
export function readEventPayload(event: { payload: unknown }) {
  return event.payload != null && typeof event.payload === "object"
    ? (event.payload as Record<string, unknown>)
    : {};
}

/** Converts structured event errors into the plain text shape old codemode APIs expose. */
export function stringifyPayloadError(value: unknown) {
  if (value == null) return undefined;
  if (typeof value === "string") return value;
  if (value != null && typeof value === "object" && "message" in value) {
    const message = (value as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return String(value);
}
