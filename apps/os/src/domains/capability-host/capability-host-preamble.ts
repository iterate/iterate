// The script preamble: TypeScript the platform injects ABOVE every codemode
// script in a scope, at typecheck and at execution, so scripts reference
// prior results and scope-authored helpers as in-scope, typed symbols instead
// of copy-pasting JSON between turns.
//
// Two sources, one assembled text:
// - the `results` array — DERIVED from the host's retained script settlements
//   (`state.settledScriptResults`), newest first, re-rendered fresh for every
//   run. It is never stored as preamble code: the settlement event is the only
//   durable storage, so there is no O(n²) re-carrying of old results.
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
 */
export function assemblePreamble(input: {
  entries: PreambleEntry[];
  results: RetainedScriptResult[];
}): AssembledPreamble | null {
  const sections: { ts: string; js: string }[] = [];
  if (input.results.length > 0) {
    sections.push(renderResultsArray(input.results));
  }
  for (const entry of input.entries) {
    const code = `// ── preamble entry ${JSON.stringify(entry.key)} ──\n${entry.code}`;
    sections.push({ ts: code, js: code });
  }
  if (sections.length === 0) return null;
  return {
    ts: sections.map((section) => section.ts).join("\n"),
    js: sections.map((section) => section.js).join("\n"),
  };
}

/**
 * The `results` array: newest first (`results[0]` is the most recent script
 * outcome in this scope). Small results embed inline and `as const` gives
 * `.data` its literal type; large results expose a throwing never-typed
 * `.data` plus a typed async `load(itx)` that reads the settlement back
 * through the scope's own capability host; failures carry `.error`.
 */
function renderResultsArray(rows: RetainedScriptResult[]): { ts: string; js: string } {
  const newestFirst = [...rows].reverse();
  const typeAliases: string[] = [];
  const tsElements: string[] = [];
  const jsElements: string[] = [];
  newestFirst.forEach((row, index) => {
    const id = JSON.stringify(row.executionId);
    switch (row.kind) {
      case "data": {
        const data = inlineDataExpression(row.resultJson);
        tsElements.push(`  { executionId: ${id}, data: ${data.ts} },`);
        jsElements.push(`  { executionId: ${id}, data: ${data.js} },`);
        break;
      }
      case "large": {
        const typeName = `Result${index}`;
        typeAliases.push(`type ${typeName} = ${row.typeText};`);
        const loadBody = `(await itx.capabilityHost.getScriptResult(${id})).data`;
        const message = JSON.stringify(
          `Large result: use \`await results[${index}].load(itx)\` instead`,
        );
        tsElements.push(
          `  {`,
          `    executionId: ${id},`,
          `    get data(): never { throw new Error(${message}); },`,
          `    load: async (itx: Itx): Promise<${typeName}> => ${loadBody} as ${typeName},`,
          `  },`,
        );
        jsElements.push(
          `  {`,
          `    executionId: ${id},`,
          `    get data() { throw new Error(${message}); },`,
          `    load: async (itx) => ${loadBody},`,
          `  },`,
        );
        break;
      }
      case "error": {
        tsElements.push(`  { executionId: ${id}, error: ${JSON.stringify(row.error)} },`);
        jsElements.push(`  { executionId: ${id}, error: ${JSON.stringify(row.error)} },`);
        break;
      }
    }
  });
  const header = "// ── prior script results, newest first (assembled by the platform) ──";
  return {
    ts: [header, ...typeAliases, "const results = [", ...tsElements, "] as const;"].join("\n"),
    js: [header, "const results = [", ...jsElements, "];"].join("\n"),
  };
}

/**
 * A small result as a source expression. JSON is valid TypeScript expression
 * syntax with ONE trap: a literal `"__proto__"` key in an object literal sets
 * the prototype instead of a plain property. Such results (rare, possibly
 * adversarial) parse at runtime instead — losing only the literal type.
 */
function inlineDataExpression(resultJson: string): { ts: string; js: string } {
  if (resultJson.includes('"__proto__"')) {
    const parsed = `JSON.parse(${JSON.stringify(resultJson)})`;
    return { ts: `${parsed} as unknown`, js: parsed };
  }
  return { ts: resultJson, js: resultJson };
}
