// lib/logs.ts — ONE structured console.warn line per call, distilled from cloudflare-os
// (backend-utils/logger-core.ts): `console.warn({ ...fields, namespace, message })`, an object
// Workers Logs stores queryably. Conventions kept from the source:
//   - `event` is the machine-readable name, dot.separated ("delivery.push.dropped") — grep and
//     alert on `event`, never on message prose.
//   - `error` accepts any caught value: printed as a string, plus `errorStack` for real Errors.
// Only `warn` exists because only warns are written — a failure the operation survives (a designed
// heal path exists: a dropped push, a stub disposed with calls in flight). UNEXPECTED failures
// don't come here — they go through reportIssue in lib/errors.ts.

/** Fields for one line — JSON-representable values; `event` names it, `error` is anything caught. */
type LogFields = Record<string, unknown> & { event?: string; error?: unknown };

/** A logger whose every line carries `namespace` — dotted and file-scoped ("subscription-delivery"). */
export function createLogger(namespace: string): {
  warn(message: string, fields?: LogFields): void;
} {
  return {
    warn(message, fields) {
      const { error: caught, ...rest } = fields ?? {};
      const line: Record<string, unknown> = { ...rest, namespace, message };
      if (caught !== undefined) {
        // `String(error)` for a real Error ("TypeError: …"); an own string `message` for impostors.
        const ownMessage = (caught as { message?: unknown } | null)?.message;
        line.error =
          caught instanceof Error || typeof ownMessage !== "string" ? String(caught) : ownMessage;
        if (caught instanceof Error && caught.stack) line.errorStack = caught.stack;
      }
      console.warn(line);
    },
  };
}
