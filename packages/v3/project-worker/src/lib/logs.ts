// lib/logs.ts — ONE structured console line per call, distilled from cloudflare-os
// (backend-utils/logger-core.ts). Every line is an object Workers Logs stores queryably:
// console.<level>({ ...fields, namespace, message }). Conventions kept from the source:
//   - `event` is the machine-readable name, dot.separated ("delivery.push.dropped") — grep and
//     alert on `event`, never on message prose.
//   - `error` accepts any caught value: printed as a string, plus `errorStack` for real Errors.
//   - spread order IS the override order: with()-fields < call fields < namespace/message.
// Deliberately dropped from the source: the AsyncLocalStorage ambient context (this worker has
// NO nodejs_compat — wrangler.jsonc), the reserved-field type gymnastics, and sampling (the
// source has none either: filtering belongs in the Workers Logs query, not in code).
// UNEXPECTED failures don't come here — they go through reportIssue in lib/errors.ts.

/** Fields for one line — JSON-representable values; `event` names it, `error` is anything caught. */
export type LogFields = Record<string, unknown> & { event?: string; error?: unknown };

/** A namespaced structured logger. `with()` forks a child; the parent never changes. */
export interface Logger {
  with(fields: Record<string, unknown>): Logger;
  /** Noisy diagnostics — leave them in, filter in the query. */
  debug(message: string, fields?: LogFields): void;
  /** Notable lifecycle moments. */
  info(message: string, fields?: LogFields): void;
  /** Failures the operation survives (a designed heal path exists). */
  warn(message: string, fields?: LogFields): void;
  /** Failures needing attention. */
  error(message: string, fields?: LogFields): void;
}

/** `String(error)` for real Errors ("TypeError: …"); an own string `message` for impostors. */
function normalizeError(error: unknown): string {
  if (error instanceof Error) return String(error);
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { message: unknown }).message;
    if (typeof message === "string") return message;
  }
  return String(error);
}

/** A logger whose every line carries `namespace` — dotted and file-scoped ("stream-do.facets"). */
export function createLogger(namespace: string, base: Record<string, unknown> = {}): Logger {
  const emit = (
    level: "debug" | "info" | "warn" | "error",
    message: string,
    fields?: LogFields,
  ) => {
    const line: Record<string, unknown> = { ...base, ...fields, namespace, message };
    const caught = fields?.error;
    if (caught === undefined) delete line.error;
    else {
      line.error = normalizeError(caught);
      if (caught instanceof Error && caught.stack) line.errorStack = caught.stack;
    }
    console[level](line);
  };
  return {
    with: (fields) => createLogger(namespace, { ...base, ...fields }),
    debug: (message, fields) => emit("debug", message, fields),
    info: (message, fields) => emit("info", message, fields),
    warn: (message, fields) => emit("warn", message, fields),
    error: (message, fields) => emit("error", message, fields),
  };
}
