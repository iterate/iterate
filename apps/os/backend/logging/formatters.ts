import { inspectValue } from "./request-log.ts";
import type { WideLog } from "./types.ts";

const MAX_PRETTY_VALUE_LENGTH = 500;

export function formatPrettyLogEvent(event: WideLog): string {
  let truncated = false;

  const lines = Object.entries(event).map(([key, value]) => {
    const inspected = inspectValue(value);
    if (inspected.length <= MAX_PRETTY_VALUE_LENGTH) return `${key}: ${inspected}`;
    truncated = true;
    return `${key}: ${inspected.slice(0, MAX_PRETTY_VALUE_LENGTH)}...`;
  });

  return [
    ...lines,
    ...(truncated && typeof event.meta?.id === "string"
      ? [`untruncatedOutput: pnpm log ${event.meta.id}`]
      : []),
  ].join("\n");
}

export function formatJsonLogEvent(event: WideLog): string {
  return JSON.stringify(event);
}
