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
  | { status: "success"; result: unknown; settledAtOffset: number }
  | { status: "error"; error: string; settledAtOffset: number }
);

const REPL_WRAPPER_HEADER = "async (itx) => {";
// JSON.parse on purpose, twice over: the no-emit execution fallback embeds
// RAW source (a `: Record<string, any>` annotation would be a SyntaxError
// there — seen live when the dev typechecker sidecar was down), and
// JSON.parse types the binding `any`, so catalogue snippets reading
// `vars.whatever` stay CLEAN through the typecheck gate (a `{}` literal
// would demote every vars-using script to the unchecked fallback).
const REPL_VARS_LINE = 'const vars = JSON.parse("{}");';

/**
 * Wrap a typed REPL body into the `async (itx) => { … }` shape `runScript`
 * expects (the same shape agent scripts and the catalogue's run-script
 * envelope use). `vars` is injected so catalogue examples run unchanged —
 * unless the body declares its own `vars`, which the specs and the examples
 * sheet's "edit the vars" flow both do.
 *
 * REPL ECHO: a trailing expression is auto-returned ({@link replScriptBody}),
 * so `1 + 1` answers 2 like any real REPL — `return` stays for multi-path
 * bodies.
 */
export function wrapReplScript(body: string): string {
  const declaresVars = /(?:^|\n)\s*(?:const|let|var)\s+vars\b/.test(body);
  return [
    REPL_WRAPPER_HEADER,
    ...(declaresVars ? [] : [REPL_VARS_LINE]),
    replScriptBody(body),
    "}",
  ].join("\n");
}

/**
 * The REPL-echo decision, synchronous and dependency-free (`new Function` is
 * the parser — same trick the deleted browser evaluator used, and it must
 * not delay Run by a worker round trip):
 *
 * 1. The WHOLE input parses as one expression → `return (input);`. The
 *    parentheses make `{ a: 1 }` an object literal, never a block.
 * 2. Otherwise, Node-REPL-style: if a trailing LINE RUN parses as an
 *    expression while everything above it parses as statements (and the
 *    combined rewrite still parses), auto-return that trailing expression —
 *    `const x = 5;\nx * 2` answers 10.
 * 3. Otherwise (ends in a declaration, has its own top-level `return`, or
 *    uses TS-only syntax `new Function` cannot parse) the body runs as
 *    written. A user-written `return` never gates an auto-return being
 *    APPENDED (rule 2 can add an unreachable one after an early return —
 *    harmless), but a body that IS a return statement parses as neither an
 *    expression nor a trailing-expression split, so it is never doubled.
 */
function replScriptBody(body: string): string {
  if (parsesAsExpression(body)) return `return (\n${body}\n);`;
  const lines = body.split("\n");
  for (let index = lines.length - 1; index > 0; index -= 1) {
    const statements = lines.slice(0, index).join("\n");
    const expression = lines.slice(index).join("\n");
    if (expression.trim() === "") continue;
    // ASI guard: when the line above is unterminated and this slice starts
    // with a continuation character, JavaScript reads ONE statement across
    // the break (`const total = a` ⏎ `+ b` is `a + b`; `foo()` ⏎ `(bar)` is
    // a call) — splitting there would change the program's meaning, so no
    // echo: exactly what running the input as written does. Same character
    // set the deleted browser evaluator's scanner used. `;`/`}` endings lift
    // the guard (known heuristic edge: a semicolon-less `const x = {}`
    // also ends in `}`; terminate lines to disambiguate, as in plain JS).
    const statementsEnd = statements.trimEnd().at(-1);
    const expressionStart = expression.trimStart()[0];
    if (
      statementsEnd !== ";" &&
      statementsEnd !== "}" &&
      expressionStart &&
      LINE_BREAK_CONTINUATION_STARTS.has(expressionStart)
    ) {
      continue;
    }
    if (!parsesAsExpression(expression)) continue;
    if (!parsesAsStatements(statements)) continue;
    const rewritten = `${statements}\nreturn (\n${expression}\n);`;
    if (!parsesAsStatements(rewritten)) continue;
    return rewritten;
  }
  return body;
}

// prettier-ignore
const LINE_BREAK_CONTINUATION_STARTS = new Set([
  "%", "&", "(", "*", "+", "-", ".", "/", ":", "<", "=", ">", "?", "[", "^", "`", "|",
]);

/** Does the input parse as ONE JavaScript expression (in an async context,
 * so top-level `await` is fine)? TS-only syntax fails conservatively. */
function parsesAsExpression(code: string): boolean {
  try {
    // oxlint-disable-next-line no-new-func -- parse test only, never invoked; see replScriptBody.
    new Function(`return async (itx) => (\n${code}\n);`);
    return true;
  } catch {
    return false;
  }
}

/** Does the input parse as an async function BODY (statements)? */
function parsesAsStatements(code: string): boolean {
  try {
    // oxlint-disable-next-line no-new-func -- parse test only, never invoked; see replScriptBody.
    new Function(`return async (itx) => {\n${code}\n};`);
    return true;
  } catch {
    return false;
  }
}

/**
 * The inverse of {@link wrapReplScript} for rendering history: strips exactly
 * the wrapper this REPL appends, including the echo rewrite's
 * `return (\n…\n);` shape, so history shows what the user TYPED. Scripts
 * that reached the scope some other way (an agent, a hand `runScript`)
 * display verbatim. (A user who literally types the rewrite's exact shape
 * displays without it — cosmetic, and the round trip is stable: re-running
 * the displayed text wraps back to the identical script.)
 */
export function scriptBodyForDisplay(code: string): string {
  if (!code.startsWith(`${REPL_WRAPPER_HEADER}\n`) || !code.endsWith("\n}")) return code;
  let body = code.slice(REPL_WRAPPER_HEADER.length + 1, -2);
  if (body.startsWith(`${REPL_VARS_LINE}\n`)) body = body.slice(REPL_VARS_LINE.length + 1);
  const RETURN_OPEN = "return (\n";
  const RETURN_CLOSE = "\n);";
  if (body.startsWith(RETURN_OPEN) && body.endsWith(RETURN_CLOSE)) {
    return body.slice(RETURN_OPEN.length, -RETURN_CLOSE.length);
  }
  const splitMarker = `\n${RETURN_OPEN}`;
  if (body.endsWith(RETURN_CLOSE) && body.includes(splitMarker)) {
    const markerIndex = body.lastIndexOf(splitMarker);
    const statements = body.slice(0, markerIndex);
    const expression = body.slice(markerIndex + splitMarker.length, -RETURN_CLOSE.length);
    return `${statements}\n${expression}`;
  }
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
    if (!executionId) continue;
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
      // The settled event's offset doubles as the entry's STABLE address:
      // it is what the preamble's results rows carry as `offset`, so the UI
      // label and `results.byOffset(n)` name the same row.
      const settledAtOffset = event.offset;
      const settled: ReplRunEntry = settlement.success
        ? settlement.data.status === "failed"
          ? { ...requested, status: "error", error: settlement.data.error, settledAtOffset }
          : {
              ...requested,
              status: "success",
              // undefined stays undefined — "the script returned nothing" and
              // "the script returned null" are different answers, and the UI
              // renders them differently.
              result: settlement.data.result,
              settledAtOffset,
            }
        : { ...requested, status: "error", error: "Malformed settlement event.", settledAtOffset };
      entries.set(executionId, settled);
    }
  }
  return [...entries.values()].sort((a, b) => a.requestedAtOffset - b.requestedAtOffset);
}

/** What the run mutation carries: the typed body plus the newest buffered
 * stream offset at submit time — the anchor that tells the pending row's
 * dedupe "my request event can only be NEWER than this". */
export type PendingRun = { afterOffset: number; body: string };

/**
 * Whether the in-flight Run already shows up in the stream-derived list (its
 * request event landed), so the local pending row can disappear. Matching on
 * code alone would let a PREVIOUS settled run of the same snippet swallow the
 * pending row (a rerun would look dead until its request lands), so the match
 * also requires the entry to be newer than the submit-time anchor.
 */
export function pendingRunVisibleInEntries(entries: readonly ReplRunEntry[], run: PendingRun) {
  return entries.some(
    (entry) => entry.requestedAtOffset > run.afterOffset && entry.code === run.body,
  );
}

/**
 * A failed script's settlement lands on the stream AND makes the run mutation
 * throw the same error text. When the newest entry already carries the
 * message, the separate mutation-error line (meant for pre-journal failures:
 * transport, host birth) stays hidden.
 */
export function runErrorAlreadyJournaled(entries: readonly ReplRunEntry[], message: string) {
  const newest = entries.at(-1);
  return !!newest && newest.status === "error" && newest.error === message;
}
