import { inspectValue } from "./request-log.ts";
import type { WideLog } from "./types.ts";

const MAX_PRETTY_VALUE_LENGTH = 500;

const formatMeta = (meta: WideLog["meta"]): string => {
  return `${meta.id}: ${new Date(meta.start).toTimeString()} ${meta.durationMs}ms`;
};
export function formatPrettyLogEvent({ meta, ...rest }: WideLog): string {
  let truncated = false;
  const lines: string[] = [];
  lines.push(formatMeta(meta));

  const additional = Object.entries(rest).map(([key, value]) => {
    let inspected: string;
    if (key === "parent" && Object.keys((value as {}) || {}).join(",") === "meta") {
      inspected = formatMeta((value as WideLog).meta);
    } else {
      inspected = inspectValue(value);
    }
    const prefix = "  ";
    if (inspected.length <= MAX_PRETTY_VALUE_LENGTH) return `${prefix}${key}: ${inspected}`;
    truncated = true;
    return `${prefix}${key}: ${inspected.slice(0, MAX_PRETTY_VALUE_LENGTH)}...`;
  });
  lines.push(...additional);
  if (truncated) lines.push(`untruncatedOutput: pnpm log ${meta.id}`);

  return lines.join("\n");
}

export function formatJsonLogEvent(event: WideLog): string {
  return JSON.stringify(event);
}
