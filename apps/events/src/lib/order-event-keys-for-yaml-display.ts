import type { Event } from "@iterate-com/events-contract";

const EVENT_YAML_DISPLAY_KEY_ORDER = [
  "type",
  "payload",
  "metadata",
  "idempotencyKey",
  "offset",
  "createdAt",
] as const;

const EVENT_YAML_DISPLAY_KEY_SET = new Set<string>(EVENT_YAML_DISPLAY_KEY_ORDER);

export function orderEventKeysForYamlDisplay(event: Event): Record<string, unknown> {
  const eventRecord = event as Record<string, unknown>;
  const orderedEvent: Record<string, unknown> = {};

  for (const key of EVENT_YAML_DISPLAY_KEY_ORDER) {
    if (key in eventRecord) {
      orderedEvent[key] = eventRecord[key];
    }
  }

  for (const [key, value] of Object.entries(eventRecord)) {
    if (key === "streamPath" || EVENT_YAML_DISPLAY_KEY_SET.has(key)) {
      continue;
    }

    orderedEvent[key] = value;
  }

  return orderedEvent;
}
