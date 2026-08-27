// core/expression.ts — THE expression codec: the STRING half (itx.streams.get("/logs")) ⇄ the
// STRUCTURED half (["itx", "streams", ["get", "/logs"]]). Args are ONE JSON5 grammar (no hand-rolled
// number/object parser; __proto__-safe); expressions are persisted NAMES, so deleting one IS
// revocation. The capability-path MATCHER + EVALUATOR/DISPATCHER live in ./evaluate.ts, re-exported.
import { z } from "zod";
import JSON5 from "json5";
export { apply, evaluate, invokePath, match, pathProxy, stepGet } from "./evaluate.ts";
export type { Match } from "./evaluate.ts";

/** One step: a property read (string) or a call (`[method, ...args]`). Args are plain JSON. */
type Step = string | [method: string, ...args: unknown[]];
/** A call written as data: a scope-root name then get/call steps. */
export type Expression = Step[];
/** Wire schema for the structured half — reduced-state checkpoints validate against this spelling. */
export const ExpressionSchema = z.array(
  z.union([z.string(), z.tuple([z.string()]).rest(z.unknown())]),
) as z.ZodType<Expression>;
/** A capability path — a mount's left side: plain dotted segments, no calls, no args. */
export type CapabilityPath = string[];
const IDENT = /^[A-Za-z_$][A-Za-z0-9_$-]*/;
const RESERVED = new Set(["__proto__", "constructor", "prototype"]);

/** Index of the `)` closing the `(` at `open`; tracks bracket depth, skipping quoted string args. */
function matchingParen(s: string, open: number): number {
  let depth = 0;
  for (let j = open; j < s.length; j++) {
    const c = s[j];
    if (c === '"' || c === "'") {
      for (const q = c; ++j < s.length && s[j] !== q; ) if (s[j] === "\\") j++;
    } else if (c === "(" || c === "[" || c === "{") depth++;
    else if ((c === ")" || c === "]" || c === "}") && --depth === 0) return j;
  }
  throw new Error(`expression: unbalanced "(" in ${JSON.stringify(s)}`);
}

/** Parse the STRING half: dotted names + `.method(args)` calls (args JSON5-parsed); rejects reserved names + bare scope calls. */
export function parse(source: string): Expression {
  const s = source.trim();
  const steps: Expression = [];
  let i = 0;
  function fail(m: string): never {
    throw new Error(`expression: ${m} in ${JSON.stringify(source)}`); // decl, not arrow: TS never-narrows
  }
  const readName = (): string => {
    const m = IDENT.exec(s.slice(i));
    if (!m) fail(`name expected at ${i}`);
    if (RESERVED.has(m[0])) fail(`reserved name "${m[0]}"`);
    i += m[0].length;
    return m[0];
  };
  steps.push(readName()); // the scope root (itx)
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) i++;
    else if (c === ".") steps.push((i++, readName()));
    else if (c === "(") {
      const end = matchingParen(s, i);
      const inner = s.slice(i + 1, end).trim();
      let args: unknown[] = [];
      try {
        if (inner !== "") args = JSON5.parse(`[${inner}]`) as unknown[];
      } catch (e) {
        fail(`call args are not JSON5 (${(e as Error).message})`);
      }
      const name = steps.pop();
      if (typeof name !== "string") fail("a call must follow a name");
      if (steps.length === 0) fail("cannot call the scope symbol itself");
      steps.push([name, ...args]);
      i = end + 1;
    } else fail(`unexpected ${JSON.stringify(c)} at ${i}`);
  }
  return steps;
}

/** Accept either half; normalize to the structured form. */
export function toExpression(input: string | Expression): Expression {
  return typeof input === "string" ? parse(input) : input;
}

/** Canonical stored form: dotted path + `.method(args)` calls (args `JSON5.stringify`d); `parse(print(e))` round-trips. */
export function print(expr: Expression): string {
  return expr
    .map((step, i) => {
      const dot = i ? "." : "";
      if (typeof step === "string") return dot + step;
      return `${dot}${step[0]}(${JSON5.stringify(step.slice(1)).slice(1, -1)})`;
    })
    .join("");
}

/** Parse a capability path ("itx.subscribers.foo") — dotted names only; a call step is a loud error. */
export function parseCapabilityPath(source: string): CapabilityPath {
  const expr = parse(source);
  if (!expr.every((step): step is string => typeof step === "string"))
    throw new Error(
      `a capability path is dotted names only — ${JSON.stringify(source)} contains a call`,
    );
  return expr;
}
