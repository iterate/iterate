import jsonata from "@mmkal/jsonata/sync";
import type { WideLog } from "./types.ts";

const compiledFilters: Record<string, ReturnType<typeof jsonata>> = {};

function getFilter(): ReturnType<typeof jsonata> | undefined {
  if (process.env.EVLOG_KEEP !== undefined) {
    throw new Error("EVLOG_KEEP is no longer supported. Use LOG_KEEP instead.");
  }

  const expr = process.env.LOG_KEEP || "true";
  return (compiledFilters[expr] ||= jsonata(expr));
}

export function shouldKeepLogEvent(event: WideLog): boolean {
  const filter = getFilter();
  if (!filter) return true;
  return Boolean(filter.evaluate(event));
}
