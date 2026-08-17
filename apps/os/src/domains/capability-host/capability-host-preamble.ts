// The script preamble: TypeScript the platform injects ABOVE every codemode
// script in a scope, at typecheck and at execution, so scripts reference
// prior results and scope-authored helpers as in-scope, typed symbols instead
// of copy-pasting JSON between turns.
//
// Two sources, one assembled text:
// - the `results` array — DERIVED from the host's retained script settlements
//   (`state.settledScriptResults`), newest first, re-rendered fresh for every
//   run. It is never stored as preamble code: the settlement event is the only
//   durable storage, so there is no O(n²) re-carrying of old results. Every
//   row carries its settlement's stream `offset`, and `results.byOffset(n)`
//   addresses a row STABLY — positions shift whenever another writer (a
//   teammate in the shared project REPL scope, another agent) lands a result,
//   offsets never do. Applies to every scope, agents included.
// - user/agent-authored entries (`state.preamble`), recorded by
//   `preamble-set` events in first-set order.
//
// Every assembly renders TWO variants of the same preamble: `ts` (what the
// typecheck gate compiles and what the emitted-JS execution path therefore
// runs) and `js` (type-stripped by construction, for the no-emit execution
// fallback, which embeds raw source and would choke on TS syntax). User
// entries cannot be auto-stripped without a compiler, so they embed verbatim
// in both — same caveat as raw scripts on the fallback path.

import { inferJsonType } from "../../lib/infer-json-type.ts";
import type { ScriptExecutionSettlement } from "./script-execution-settlement.ts";

/** How many settled script outcomes the host retains for the `results` array.
 * Older outcomes stay readable in chat history and in the stream itself. */
export const RETAINED_SCRIPT_RESULTS_LIMIT = 20;

/** Serialized-JSON size up to which a result embeds inline as a literal
 * (typed by the literal, via `as const`). Larger results contribute their
 * inferred type plus an async loader instead — mirroring the render-side
 * spill threshold's small-vs-large split without inventing a new one. */
export const INLINE_RESULT_PREAMBLE_LIMIT = 16_000;

/** Retained error text cap — errors are context, not payload. */
const RETAINED_ERROR_LIMIT = 2_000;

/** Char budget for a large result's inferred type text. */
const RESULT_TYPE_MAX_CHARS = 3_000;

/** One retained script outcome — a row of the derived `results` array.
 * Structurally identical to the contract's `settledScriptResults` element
 * (the contract pins it with `satisfies`). */
export type RetainedScriptResult =
  | { kind: "data"; executionId: string; settledAtOffset: number; resultJson: string }
  | { kind: "large"; executionId: string; settledAtOffset: number; typeText: string }
  | { kind: "error"; executionId: string; settledAtOffset: number; error: string };

/** A user/agent-authored preamble entry, as reduced into host state. */
export type PreambleEntry = { key: string; code: string; setAtOffset: number };

/**
 * Classify one settlement into its retained row — the pure half of the
 * `script-run-settled` reduce. Returns null for settlements with nothing to
 * reference (a successful script that returned undefined ended its turn).
 */
export function retainedScriptResult(input: {
  executionId: string;
  settledAtOffset: number;
  settlement: ScriptExecutionSettlement;
}): RetainedScriptResult | null {
  const { executionId, settledAtOffset, settlement } = input;
  if (settlement.status === "failed") {
    return {
      kind: "error",
      executionId,
      settledAtOffset,
      error:
        settlement.error.length <= RETAINED_ERROR_LIMIT
          ? settlement.error
          : `${settlement.error.slice(0, RETAINED_ERROR_LIMIT)}…`,
    };
  }
  if (settlement.result === undefined) return null;
  const resultJson = JSON.stringify(settlement.result);
  if (typeof resultJson !== "string") return null;
  if (resultJson.length <= INLINE_RESULT_PREAMBLE_LIMIT) {
    return { kind: "data", executionId, settledAtOffset, resultJson };
  }
  return {
    kind: "large",
    executionId,
    settledAtOffset,
    typeText: inferJsonType(settlement.result, { maxChars: RESULT_TYPE_MAX_CHARS }),
  };
}

export type AssembledPreamble = {
  /** The TypeScript preamble: compiled by the typecheck gate, and therefore
   * what the emitted-JS execution path runs. */
  ts: string;
  /** The type-free rendering for the no-emit execution fallback. Platform
   * parts are JS by construction; user entries embed verbatim. */
  js: string;
};

/**
 * Render a scope's preamble. Returns null when there is nothing to inject —
 * the common empty scope pays nothing.
 *
 * ONE source, two derivations: every section is a single marked string in
 * which TS-only spans (annotations, casts, type aliases — always purely
 * additive) are wrapped by {@link markedRenderer}'s `tsOnly`. `toTs` strips
 * just the markers; `toJs` strips the marked spans. The variants cannot
 * diverge by carelessness because nobody writes them separately.
 */
export function assemblePreamble(input: {
  /** Injection order is the array order (state keeps first-set order). */
  entries: Pick<PreambleEntry, "key" | "code">[];
  results: RetainedScriptResult[];
}): AssembledPreamble | null {
  const renderer = markedRenderer();
  const sections: string[] = [];
  if (input.results.length > 0) {
    sections.push(renderResultsArray(input.results, renderer.tsOnly));
  }
  for (const entry of input.entries) {
    // User entries embed verbatim in BOTH variants — they cannot be
    // auto-stripped without a compiler; same caveat as raw scripts on the
    // no-emit fallback path.
    sections.push(`// ── preamble entry ${JSON.stringify(entry.key)} ──\n${entry.code}`);
  }
  if (sections.length === 0) return null;
  const marked = sections.join("\n");
  return { ts: renderer.toTs(marked), js: renderer.toJs(marked) };
}

/**
 * The `results` array: newest first (`results[0]` is the most recent script
 * outcome in this scope). Small results embed inline and `as const` gives
 * `.data` its literal type; large results expose a throwing never-typed
 * `.data` plus a typed async `load(itx)` that reads the settlement back
 * through the scope's own capability host; failures carry `.error`.
 *
 * Every row also carries `offset` — its settlement's stream offset — and the
 * array wears a `results.byOffset(n)` helper for STABLE addressing: in a
 * shared scope (the project REPL, an agent another writer scripts into),
 * positions shift as new results land, but the settle offset names one row
 * forever. Retention still applies: byOffset only sees the retained window
 * (RETAINED_SCRIPT_RESULTS_LIMIT), and throws for anything older or unknown.
 */
function renderResultsArray(rows: RetainedScriptResult[], tsOnly: (code: string) => string) {
  const newestFirst = [...rows].reverse();
  const typeAliases: string[] = [];
  const elements: string[] = [];
  newestFirst.forEach((row, index) => {
    const id = JSON.stringify(row.executionId);
    switch (row.kind) {
      case "data":
        elements.push(
          `  { offset: ${row.settledAtOffset}, executionId: ${id}, data: ${inlineDataExpression(row.resultJson, tsOnly)} },`,
        );
        break;
      case "large": {
        const typeName = `Result${index}`;
        typeAliases.push(tsOnly(`type ${typeName} = ${row.typeText};\n`));
        const loadBody = `(await itx.capabilityHost.getScriptResult(${id})).data`;
        const message = JSON.stringify(
          `Large result: use \`await results[${index}].load(itx)\` instead`,
        );
        elements.push(
          `  {`,
          `    offset: ${row.settledAtOffset},`,
          `    executionId: ${id},`,
          `    get data()${tsOnly(": never")} { throw new Error(${message}); },`,
          `    load: async (itx${tsOnly(": Itx")})${tsOnly(`: Promise<${typeName}>`)} => ${loadBody}${tsOnly(` as ${typeName}`)},`,
          `  },`,
        );
        break;
      }
      case "error":
        elements.push(
          `  { offset: ${row.settledAtOffset}, executionId: ${id}, error: ${JSON.stringify(row.error)} },`,
        );
        break;
    }
  });
  return [
    "// ── prior script results, newest first (assembled by the platform) ──",
    // Whole-line TS-only sections carry their own trailing newline inside the
    // span (see typeAliases above), so the js variant has no blank ghosts.
    `${typeAliases.join("")}const __resultRows = [`,
    ...elements,
    `]${tsOnly(" as const")};`,
    // Positional AND stable addressing on one value: the tuple keeps
    // per-index literal types (results[0].data), byOffset names a row by its
    // settle offset — stable while others append to a shared scope. The
    // generic keys on the tuple's LITERAL offset types, so byOffset(16)
    // returns exactly the row settled at 16 (a retained error row elsewhere
    // in the window cannot poison `.data` with a union), and an offset
    // outside the retained window is a compile-time error before it is a
    // runtime throw.
    `const results = Object.assign(__resultRows, {`,
    `  /** The row settled at this stream offset (entries are labeled with it); offsets outside the retained window error at typecheck and throw at runtime. */`,
    `  byOffset: ${tsOnly(`<O extends (typeof __resultRows)[number]["offset"]>`)}(offset${tsOnly(": O")}) => {`,
    `    const match = __resultRows.find((row) => row.offset === offset);`,
    `    if (!match) throw new Error("no retained script result settled at offset " + offset);`,
    `    return match${tsOnly(" as Extract<(typeof __resultRows)[number], { offset: O }>")};`,
    `  },`,
    `});`,
  ].join("\n");
}

/**
 * The single-source marker scheme. `tsOnly` wraps a purely-additive
 * TypeScript span; `toTs` keeps the span and drops the markers; `toJs` drops
 * span and markers together. The marker id is random per assembly so
 * adversarial content (a result JSON containing marker-shaped text) cannot
 * terminate or open a span.
 */
function markedRenderer() {
  const id = Math.random().toString(36).slice(2);
  const begin = `/*ts:begin:${id}*/`;
  const end = `/*ts:end:${id}*/`;
  return {
    tsOnly: (code: string) => `${begin}${code}${end}`,
    toTs: (marked: string) => marked.split(begin).join("").split(end).join(""),
    toJs: (marked: string) =>
      marked
        .split(begin)
        .map((chunk, index) => (index === 0 ? chunk : chunk.slice(chunk.indexOf(end) + end.length)))
        .join(""),
  };
}

/**
 * A small result as a source expression. JSON is valid TypeScript expression
 * syntax with ONE trap: a literal `"__proto__"` key in an object literal sets
 * the prototype instead of a plain property. Such results (rare, possibly
 * adversarial) parse at runtime instead — losing only the literal type.
 */
function inlineDataExpression(resultJson: string, tsOnly: (code: string) => string): string {
  if (resultJson.includes('"__proto__"')) {
    return `JSON.parse(${JSON.stringify(resultJson)})${tsOnly(" as unknown")}`;
  }
  return resultJson;
}
