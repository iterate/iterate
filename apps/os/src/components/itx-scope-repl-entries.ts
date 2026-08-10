// The pure half of the durable REPL: the envelope a typed REPL body is
// wrapped in before it goes to `capabilityHosts.get(scope).runScript`, and
// the derivation of the visible entry list from the scope stream's
// `script-run-requested` / `script-run-settled` events. History is
// stream-derived by design — reload replays the same events and re-derives
// the same entries (tasks/durable-repl.md).

import type { StreamEvent } from "iterate/processors";
import { ScriptExecutionSettlement } from "~/domains/capability-host/script-execution-settlement.ts";

const SCRIPT_RUN_REQUESTED = "events.iterate.com/capability-host/script-run-requested";
const SCRIPT_RUN_SETTLED = "events.iterate.com/capability-host/script-run-settled";

/** The event types the REPL's stream buffer keeps (everything else on the
 * scope stream — births, preamble sets, started markers — is noise here). */
export const REPL_SCRIPT_EVENT_TYPES = [SCRIPT_RUN_REQUESTED, SCRIPT_RUN_SETTLED] as const;

/** One REPL run as rendered: the request event is the row's identity; a
 * matching settlement upgrades it from running to success/error. */
export type ReplRunEntry = {
  /** What the user typed — the deterministic wrapper is stripped for display. */
  code: string;
  executionId: string;
  requestedAt: string;
  requestedAtOffset: number;
} & (
  | { status: "running" }
  | { status: "success"; result: unknown }
  | { status: "error"; error: string }
);

const REPL_WRAPPER_HEADER = "async (itx) => {";
const REPL_VARS_LINE = "const vars: Record<string, any> = {};";

/**
 * Wrap a typed REPL body into the `async (itx) => { … }` shape `runScript`
 * expects (the same shape agent scripts and the catalogue's run-script
 * envelope use). `vars` is injected so catalogue examples run unchanged —
 * unless the body declares its own `vars`, which the specs and the examples
 * sheet's "edit the vars" flow both do.
 */
export function wrapReplScript(body: string): string {
  const declaresVars = /(?:^|\n)\s*(?:const|let|var)\s+vars\b/.test(body);
  return [REPL_WRAPPER_HEADER, ...(declaresVars ? [] : [REPL_VARS_LINE]), body, "}"].join("\n");
}

/**
 * The inverse of {@link wrapReplScript} for rendering history: strips exactly
 * the wrapper this REPL appends. Scripts that reached the scope some other
 * way (an agent, a hand `runScript`) display verbatim.
 */
export function scriptBodyForDisplay(code: string): string {
  if (!code.startsWith(`${REPL_WRAPPER_HEADER}\n`) || !code.endsWith("\n}")) return code;
  let body = code.slice(REPL_WRAPPER_HEADER.length + 1, -2);
  if (body.startsWith(`${REPL_VARS_LINE}\n`)) body = body.slice(REPL_VARS_LINE.length + 1);
  return body;
}

/**
 * Fold the scope stream's script events into the entry list, oldest first.
 * A request without a settlement renders as running (recovery guarantees it
 * eventually settles — orphaned/expired runs settle as failures).
 */
export function deriveReplEntries(events: readonly StreamEvent[]): ReplRunEntry[] {
  const entries = new Map<string, ReplRunEntry>();
  for (const event of events) {
    const payload = event.payload as Record<string, unknown>;
    const executionId = typeof payload?.executionId === "string" ? payload.executionId : null;
    if (executionId === null) continue;
    if (event.type === SCRIPT_RUN_REQUESTED && typeof payload.code === "string") {
      entries.set(executionId, {
        code: scriptBodyForDisplay(payload.code),
        executionId,
        requestedAt: event.createdAt,
        requestedAtOffset: event.offset,
        status: "running",
      });
      continue;
    }
    if (event.type === SCRIPT_RUN_SETTLED) {
      const requested = entries.get(executionId);
      if (!requested) continue; // replay starts at 0, so this only guards malformed streams
      const settlement = ScriptExecutionSettlement.safeParse(payload.settlement);
      const settled: ReplRunEntry = !settlement.success
        ? { ...requested, status: "error", error: "Malformed settlement event." }
        : settlement.data.status === "failed"
          ? { ...requested, status: "error", error: settlement.data.error }
          : { ...requested, status: "success", result: settlement.data.result ?? null };
      entries.set(executionId, settled);
    }
  }
  return [...entries.values()].sort((a, b) => a.requestedAtOffset - b.requestedAtOffset);
}

/**
 * Whether the in-flight Run already shows up in the stream-derived list (its
 * request event landed), so the local pending row can disappear. Run is
 * single-flight in the UI, so "newest running entry matches the pending body"
 * is exact in practice.
 */
export function pendingRunVisibleInEntries(entries: readonly ReplRunEntry[], body: string) {
  const newest = entries.at(-1);
  return newest !== undefined && newest.code === body;
}

/**
 * A failed script's settlement lands on the stream AND makes the run mutation
 * throw the same error text. When the newest entry already carries the
 * message, the separate mutation-error line (meant for pre-journal failures:
 * transport, host birth) stays hidden.
 */
export function runErrorAlreadyJournaled(entries: readonly ReplRunEntry[], message: string) {
  const newest = entries.at(-1);
  return newest !== undefined && newest.status === "error" && newest.error === message;
}
