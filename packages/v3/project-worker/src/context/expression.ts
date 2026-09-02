// context/expression.ts — THE expression codec: the STRING half (itx.facets.get("core")) ⇄ the
// STRUCTURED half (["itx", "facets", ["get", "core"]]). Args are ONE JSON5 grammar (no hand-rolled
// number/object parser; __proto__-safe); expressions are persisted NAMES, so deleting one IS
// revocation. The mount matcher + rewriter is ./routing.ts; the evaluator is ./dispatch.ts.
import JSON5 from "json5";

/** One step: a property read (string) or a call (`[method, ...args]`). Args are plain JSON. The
 *  method `""` is the ANONYMOUS call — call the value itself: `itx.rpcStubs.get('cam')(1, 2)` is
 *  `["itx","rpcStubs",["get","cam"],["",1,2]]` — what a mount rewrite spells when a live value is
 *  called with args. */
type ItxExpressionStep = string | [method: string, ...args: unknown[]];
/** An itx expression as data: the scope root (`itx`) then get/call steps. THE parsed form every door
 *  works on. */
export type ItxExpression = ItxExpressionStep[];
/** THE dispatch target, in EITHER codec half — a dotted string that starts with the scope root
 *  (`"itx.facets.get('core')"`) OR the parsed structured form (`["itx","facets",["get","core"]]`).
 *  Both carry call args (the string via `.method(args)`), and `toItxExpression` normalizes either to the
 *  structured form — so either works wherever one works, at every door that dispatches. */
export type ItxExpressionInput = string | ItxExpression;
/** A capability path: dotted names, any of which may be a call step PINNING literal args —
 *  `itx.ai.run` or `itx.ai.run('gpt-5')` or `itx.repo.get('main').files`. A pinned arg must equal the
 *  call's arg at that position for the mount to match, and is CONSUMED by the match (partial
 *  application): `itx.ai.run('gpt-5') ⇒ itx.openai.chat` makes `itx.ai.run('gpt-5', inputs)` into
 *  `itx.openai.chat(inputs)`. */
export type ItxExpressionPrefix = ItxExpression;
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
export function parse(source: string): ItxExpression {
  const s = source.trim();
  const steps: ItxExpression = [];
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
      const previous = steps.at(-1);
      if (Array.isArray(previous))
        steps.push(["", ...args]); // `f(x)(y)`: call the result itself
      else {
        const name = steps.pop();
        if (typeof name !== "string") fail("a call must follow a name");
        if (steps.length === 0) fail("cannot call the scope symbol itself");
        steps.push([name, ...args]);
      }
      i = end + 1;
    } else fail(`unexpected ${JSON.stringify(c)} at ${i}`);
  }
  return steps;
}

/** Accept either half of an `ItxExpressionInput`; normalize to the structured form. */
export function toItxExpression(input: ItxExpressionInput): ItxExpression {
  return typeof input === "string" ? parse(input) : input;
}

/** Canonical stored form: dotted path + `.method(args)` calls (args `JSON5.stringify`d); `parse(print(e))` round-trips. */
export function print(expr: ItxExpression): string {
  return expr
    .map((step, i) => {
      const dot = i ? "." : "";
      if (typeof step === "string") return dot + step;
      const args = JSON5.stringify(step.slice(1)).slice(1, -1);
      return step[0] === "" ? `(${args})` : `${dot}${step[0]}(${args})`;
    })
    .join("");
}

/** Parse a capability path — dotted names, optionally pinning literal args on call steps
 *  (`itx.ai.run('gpt-5')`). A call step with NO args pins nothing and is the same path as the plain
 *  name, so it is refused: spell `itx.ai.run`. */
export function parseItxExpressionPrefix(source: string): ItxExpressionPrefix {
  const expr = parse(source);
  for (const step of expr) {
    if (Array.isArray(step) && step[0] === "")
      throw new Error(`a capability path cannot call a result — ${JSON.stringify(source)}`);
    if (Array.isArray(step) && step.length === 1)
      throw new Error(
        `a capability path pins literal args with a call step — ${JSON.stringify(source)} has "${step[0]}()" with none; spell "${step[0]}"`,
      );
  }
  return expr;
}

/** THE ONE canonical spelling of a capability path — what the table stores, what a live stub is
 *  lent under, what `revoke(path)` matches: parsed, then printed (dotted names; pinned args as
 *  JSON5 literals). */
export function canonicalItxExpressionPrefix(source: string): string {
  return print(parseItxExpressionPrefix(source));
}
