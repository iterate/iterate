import jsonata from "@mmkal/jsonata/sync";
import type { WideLog } from "./types.ts";

let compiledFilter: ReturnType<typeof jsonata> | undefined;
let filterInitialized = false;
let compiledExpr: string | undefined;

function getFilter(): ReturnType<typeof jsonata> | undefined {
  if (process.env.EVLOG_KEEP !== undefined) {
    throw new Error("EVLOG_KEEP is no longer supported. Use LOG_KEEP instead.");
  }

  const expr = process.env.LOG_KEEP;
  if (filterInitialized && expr === compiledExpr) return compiledFilter;

  filterInitialized = true;
  compiledExpr = expr;

  if (!expr) {
    compiledFilter = undefined;
    return compiledFilter;
  }

  compiledFilter = jsonata(expr);
  return compiledFilter;
}

export function shouldKeepLogEvent(event: WideLog): boolean {
  const filter = getFilter();
  if (!filter) return true;
  return Boolean(filter.evaluate(event));
}
