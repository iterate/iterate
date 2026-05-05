import type { Event } from "@iterate-com/events-contract";
import type {
  EventsStreamBuiltInElement,
  EventsStreamRawEventSummary,
} from "@iterate-com/ui/components/events/feed-items";

/** Build a map of offset → elapsed time label (e.g. "+2.3s") for consecutive events. */
export function getElapsedByOffset(feedItems: readonly EventsStreamBuiltInElement[]) {
  const elapsedByOffset = new Map<number, string>();
  const rawEvents = feedItems
    .flatMap((item) => (item.type === "grouped-raw-event" ? item.props.events : []))
    .sort((a, b) => a.offset - b.offset);

  for (const [index, item] of rawEvents.entries()) {
    const previousItem = rawEvents[index - 1];
    if (previousItem == null) continue;

    elapsedByOffset.set(item.offset, formatElapsedTime(item.timestamp - previousItem.timestamp));
  }

  return elapsedByOffset;
}

export function formatEventSummary(item: EventsStreamRawEventSummary, elapsedLabel?: string) {
  return [item.offset, item.eventType, elapsedLabel, formatTime(item.timestamp)]
    .filter(Boolean)
    .join(" · ");
}

/** Reorder event keys for readable YAML: type, payload, metadata first, then the rest. */
export function orderEventKeysForYamlDisplay(event: Event): Record<string, unknown> {
  const eventRecord = event as Record<string, unknown>;
  const orderedEvent: Record<string, unknown> = {};

  for (const key of ["type", "payload", "metadata", "idempotencyKey", "offset", "createdAt"]) {
    if (key in eventRecord) {
      orderedEvent[key] = eventRecord[key];
    }
  }

  for (const [key, value] of Object.entries(eventRecord)) {
    if (key === "streamPath" || key in orderedEvent) {
      continue;
    }

    orderedEvent[key] = value;
  }

  return orderedEvent;
}

/** Hard-wrap a string at `width` characters, returning one or more lines. */
export function wrapLine(value: string, width: number) {
  if (value.length <= width) return [value];

  const lines: string[] = [];
  for (let index = 0; index < value.length; index += width) {
    lines.push(value.slice(index, index + width));
  }
  return lines;
}

/** Right-align text to `width` chars, truncating from the left if too long. */
export function rightAlign(value: string, width: number) {
  const trimmed = value.length > width ? value.slice(value.length - width) : value;
  return trimmed.padStart(width);
}

export function formatTime(timestamp: number) {
  return new Date(timestamp).toLocaleTimeString();
}

export function formatElapsedTime(durationMs: number) {
  const normalizedDurationMs = Math.max(0, Math.floor(durationMs));

  if (normalizedDurationMs < 1_000) {
    return `+${normalizedDurationMs}ms`;
  }

  if (normalizedDurationMs < 60_000) {
    const seconds = Math.floor(normalizedDurationMs / 100) / 10;
    return `+${seconds.toFixed(1).replace(/\.0$/, "")}s`;
  }

  const totalSeconds = Math.floor(normalizedDurationMs / 1_000);
  const totalMinutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  return `+${totalMinutes}m${seconds}s`;
}
