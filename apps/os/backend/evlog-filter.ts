import jsonata from "jsonata";

/**
 * JSONata-based log filter for evlog wide events.
 *
 * Controlled by the `EVLOG_KEEP` env var (or `process.env.EVLOG_KEEP`).
 * The expression receives the request context object and should return
 * truthy to **keep** (emit) the log, falsy to **drop** it.
 *
 * Default expression (when unset):
 *   `level != 'info' or request.status >= 400 or request.duration >= 500`
 *
 * i.e. keep errors/warnings unconditionally, keep info only if status >= 400 or slow.
 *
 * Examples:
 *   - Keep everything:              `true`
 *   - Keep only errors:             `level = 'error'`
 *   - Keep slow + errors:           `level != 'info' or request.duration >= 1000`
 *   - Keep specific paths:          `$contains(request.path, 'orpc')`
 *   - Combine conditions:           `level != 'info' or request.status >= 400 or request.duration >= 500 or $contains(request.path, 'orpc-daemon')`
 */

const DEFAULT_KEEP_EXPRESSION =
  "level != 'info' or request.status >= 400 or request.duration >= 500";

let compiledFilter: jsonata.Expression | undefined;
let filterInitialized = false;

function getFilter(): jsonata.Expression | undefined {
  if (!filterInitialized) {
    filterInitialized = true;
    const expr = process.env.EVLOG_KEEP ?? DEFAULT_KEEP_EXPRESSION;
    try {
      compiledFilter = jsonata(expr);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[evlog-filter] Invalid EVLOG_KEEP expression: ${expr}`, err);
      compiledFilter = undefined; // no filtering on bad expression — keep everything
    }
  }
  return compiledFilter;
}

/**
 * Evaluate whether a log event should be kept (emitted).
 * Returns `true` to keep, `false` to drop.
 *
 * JSONata v2 is async, so this returns a Promise.
 * When no filter is configured (or expression is invalid), resolves to `true`.
 */
export async function shouldKeepEvent(context: Record<string, unknown>): Promise<boolean> {
  const filter = getFilter();
  if (!filter) return true;

  try {
    const result = await filter.evaluate(context);
    return Boolean(result);
  } catch {
    // On eval error, keep the log to be safe
    return true;
  }
}
