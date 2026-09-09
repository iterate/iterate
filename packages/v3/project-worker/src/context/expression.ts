// context/expression.ts — THE expression codec: the STRING half (itx.facets.get("core")) ⇄ the
// STRUCTURED half (["itx", "facets", ["get", "core"]]). Args are ONE JSON5 grammar, comments included
// (no hand-rolled number/object parser; __proto__-safe); expressions are persisted NAMES, so deleting
// one IS revocation. The rewrite rules (match, rank, rewrite) are ./itx-expression-rewriting.ts; the evaluator
// is ./dispatch.ts.
import JSON5 from "json5";
import { codedError } from "../lib/errors.ts";
import { jsonEqual } from "../lib/patch.ts";

/** A STRING expression is for what a person types: short. Anything bigger — a worker's source, a large
 *  literal — rides the PARSED form (`["itx","workers",["get",{ source }]]`), which is plain data and never
 *  meets json5. The cap is O(1), before any parsing (stock json5 allocates per character and a
 *  multi-megabyte literal kills a 128 MiB isolate — the 2026-09-07 wave-0 plan, issue 2). */
const ITX_EXPRESSION_STRING_MAX_CHARS = 2048;

/** One step: a property read (string) or a call (`[method, ...args]`). Args are plain JSON. The
 *  method `""` is the ANONYMOUS call — call the value itself: `itx.builtins.rpcStubs.get('cam')(1, 2)`
 *  is `["itx","builtins","rpcStubs",["get","cam"],["",1,2]]` — what a `provide(stub)` rule spells when
 *  the lent stub is called with args. */
export type ItxExpressionStep = string | [method: string, ...args: unknown[]];
/** An itx expression as data: the scope root (`itx`) then get/call steps. THE parsed form every door
 *  works on. */
export type ItxExpression = ItxExpressionStep[];
/** THE dispatch target, in EITHER codec half — a dotted string that starts with the scope root
 *  (`"itx.facets.get('core')"`) OR the parsed structured form (`["itx","facets",["get","core"]]`).
 *  Both carry call args (the string via `.method(args)`), and `toItxExpression` normalizes either to the
 *  structured form — so either works wherever one works, at every door that dispatches. */
export type ItxExpressionInput = string | ItxExpression;
/** An itx-expression PREFIX — a rewrite rule's `match`: dotted names, any of which may be a call step
 *  PINNING literal args — `itx.ai.run` or `itx.ai.run('gpt-5')` or `itx.repo.get('main').files`. A
 *  pinned arg must equal the call's arg at that position for the rule to match, and is CONSUMED by
 *  the match (partial application): `itx.ai.run('gpt-5') ⇒ itx.openai.chat` makes
 *  `itx.ai.run('gpt-5', inputs)` into `itx.openai.chat(inputs)`. */
export type ItxExpressionPrefix = ItxExpression;
/** The name a step carries: the property itself, or a call step's method. */
export const itxExpressionStepName = (step: ItxExpressionStep | undefined): string | undefined =>
  Array.isArray(step) ? step[0] : step;

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$-]*/;
const RESERVED = new Set(["__proto__", "constructor", "prototype"]);

// ── `@`, THE CALLER'S INPUT — a rewrite rule's target may hold it, nothing else may ──
// In the string half a bare `@` outside a string literal is the marker (`'@cf/…'` inside quotes is a
// string like any other); `...@` as an object-literal entry is the merge form. In the array half the
// marker is ONE reserved literal, `{ "@": true }`, and the merge entry the key `"...@"` with the value
// `true` — so the stored form is plain JSON, and those two spellings are unspellable as literals in a
// target (the codec's one reservation). What `@` MEANS is rule 7 in ./itx-expression-rewriting.ts; here
// it is only lexed (parse, targets only) and printed back (print, targets only).
/** The marker's array-half spelling, the one reserved literal. */
const ITX_EXPRESSION_HOLE = { "@": true } as const;
/** The merge entry's key — `...@` — read by rule 7. */
export const ITX_EXPRESSION_MERGE_KEY = "...@";

/** A single- or double-quoted string literal (escapes honored) or a JSON5 comment (block or line):
 *  THE one pattern every walk that must skip what is inside them is built from — the marker lex, the
 *  marker print, the paren matcher. In an alternation a span is consumed whole, so nothing inside one
 *  (a quote in a comment, an `@` in a string) is ever seen by the other alternatives. */
const STRING_OR_COMMENT = String.raw`"(?:[^"\\]|\\[\s\S])*"|'(?:[^'\\]|\\[\s\S])*'|/\*[\s\S]*?\*/|//[^\n]*`;
const isStringOrComment = (match: string): boolean =>
  match[0] === '"' || match[0] === "'" || match[0] === "/";
/** In call args: a literal (kept verbatim) or a marker — `...@` before `@`, so the merge form wins. */
const MARKERS_IN_ARGS = new RegExp(`${STRING_OR_COMMENT}|\\.\\.\\.@|@`, "g");
/** In JSON5's printed output: the marker literal `{'@':true}` and the merge entry `'...@':true` are
 *  spelled with a single-quoted key and matched on those exact boundaries — listed BEFORE the literal
 *  alternative so the entry's `'...@'` is read as the entry, not as a string. A user's string that
 *  merely contains those characters is emitted by JSON5 as a longer (double-quoted) literal and is
 *  consumed whole. */
const MARKERS_IN_PRINT = new RegExp(`\\{'@':true\\}|'\\.\\.\\.@':true|${STRING_OR_COMMENT}`, "g");
/** A bracket outside a literal. */
const BRACKETS = new RegExp(`${STRING_OR_COMMENT}|[()[\\]{}]`, "g");

/** Is `value` the marker literal `{ "@": true }`? */
export const isItxExpressionHole = (value: unknown): boolean =>
  jsonEqual(value, ITX_EXPRESSION_HOLE);

/** Does `value` (a step, an arg tree, a whole expression) hold the marker or a merge entry anywhere? */
export function containsItxExpressionHole(value: unknown): boolean {
  if (isItxExpressionHole(value)) return true;
  if (Array.isArray(value)) return value.some(containsItxExpressionHole);
  if (value !== null && typeof value === "object")
    return (
      (value as Record<string, unknown>)[ITX_EXPRESSION_MERGE_KEY] === true ||
      Object.values(value).some(containsItxExpressionHole)
    );
  return false;
}

/** Index of the `)` closing the `(` at `open`; tracks bracket depth, skipping quoted string args. */
function matchingParen(source: string, open: number): number {
  let depth = 0;
  BRACKETS.lastIndex = open;
  for (let bracket = BRACKETS.exec(source); bracket; bracket = BRACKETS.exec(source)) {
    if (isStringOrComment(bracket[0])) continue;
    if ("([{".includes(bracket[0])) depth++;
    else if (--depth === 0) return bracket.index;
  }
  throw new Error(`expression: unbalanced "(" in ${JSON.stringify(source)}`);
}

/** Parse the STRING half: dotted names + `.method(args)` calls (args JSON5-parsed); rejects reserved
 *  names + bare scope calls. `holes: true` — a rewrite rule's TARGET only — lexes `@` / `...@` into
 *  the marker literals; anywhere else a bare `@` is refused. */
export function parse(source: string, options?: { holes?: boolean }): ItxExpression {
  if (source.length > ITX_EXPRESSION_STRING_MAX_CHARS)
    throw codedError(
      "EXPRESSION_TOO_LONG",
      `itx expression: ${source.length} chars is over the ${ITX_EXPRESSION_STRING_MAX_CHARS}-char limit for the string form — a string expression is for what a person types; pass the parsed form instead: ["itx","workers",["get",{ source: … }]]`,
    );
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
      const raw = s.slice(i + 1, end).trim();
      // `@` outside a string literal: the marker (targets only), a refusal everywhere else.
      const inner = raw.replace(MARKERS_IN_ARGS, (match) => {
        if (isStringOrComment(match)) return match;
        if (!options?.holes)
          fail("`@` (the caller's input) is legal only in a rewrite rule's target");
        return match === "@"
          ? JSON.stringify(ITX_EXPRESSION_HOLE)
          : `${JSON.stringify(ITX_EXPRESSION_MERGE_KEY)}:true`;
      });
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
export function toItxExpression(
  input: ItxExpressionInput,
  options?: { holes?: boolean },
): ItxExpression {
  return typeof input === "string" ? parse(input, options) : input;
}

/** The array half, checked the way the parser checks the string half — every name step an identifier
 *  that is not reserved, every call step `[method, ...args]` with an identifier method (or `""`, the
 *  anonymous call, only right after a call) — WITHOUT printing and re-parsing: a stored target carries a worker's whole source as
 *  data, and that data must never meet the string codec (the 2 KiB cap, json5). Throws in the
 *  parser's words. */
function assertItxExpressionShape(expression: ItxExpression): void {
  const fail = (m: string): never => {
    throw new Error(`expression: ${m} in ${JSON.stringify(expression).slice(0, 200)}`);
  };
  if (!Array.isArray(expression) || expression.length === 0)
    fail("an expression is a non-empty array");
  const name = (step: string, what: string) => {
    if (!IDENT.test(step) || IDENT.exec(step)![0] !== step)
      fail(`${what} ${JSON.stringify(step)} is not an identifier`);
    if (RESERVED.has(step)) fail(`reserved name "${step}"`);
  };
  expression.forEach((step, i) => {
    if (typeof step === "string") {
      name(step, i === 0 ? "the root" : "a name step");
      return;
    }
    if (!Array.isArray(step) || typeof step[0] !== "string")
      fail(`step ${i} is neither a name nor [method, ...args]`);
    const [method] = step;
    if (method === "") {
      if (i === 0 || !Array.isArray(expression[i - 1]))
        fail("the anonymous call `f(x)(y)` follows a call");
    } else name(method, "a method");
    if (i === 0) fail("a call on the root itself");
  });
  // No hole check on the array half: `{ "@": true }` carried as DATA is data (edge#6) — only the
  // STRING form lexes a bare `@` into the marker, and only for a rule's target.
}

/** Either half, normalized to the array half and checked: a string is parsed (short by rule), an
 *  array is shape-checked in place. THE one door the event builders use for a configured target. */
export function normalizedItxExpression(
  input: ItxExpressionInput,
  options?: { holes?: boolean },
): ItxExpression {
  if (typeof input === "string") return parse(input, options);
  assertItxExpressionShape(input);
  return input;
}

/** Object args print with their keys SORTED, so two spellings of one object are one canonical string
 *  — one rewrite-rule row, one facet memo, one library connection memo (library/index.ts) — the way
 *  `jsonEqual` already matches them. A `JSON.stringify` / `JSON5.stringify` replacer. */
export const keySortedForPrint = (_key: string, value: unknown): unknown =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(
        Object.keys(value as Record<string, unknown>)
          .sort()
          .map((k) => [k, (value as Record<string, unknown>)[k]]),
      )
    : value;

/** Canonical stored form: dotted path + `.method(args)` calls (args `JSON5.stringify`d, object keys
 *  sorted). `holes: true` — a rewrite rule's TARGET only — spells the marker literals back as `@` /
 *  `...@`, and `parse(print(e, { holes: true }), { holes: true })` round-trips; without it the
 *  reserved literals print as the plain JSON5 they are, so a CALL that happens to carry `{ "@": true }`
 *  as data round-trips through `parse` (no holes) unchanged — the resolve/invoke law holds for it. */
export function print(expr: ItxExpression, options?: { holes?: boolean }): string {
  return expr
    .map((step, i) => {
      const dot = i ? "." : "";
      if (typeof step === "string") return dot + step;
      const json = JSON5.stringify(step.slice(1), keySortedForPrint).slice(1, -1);
      const args = options?.holes
        ? json.replace(MARKERS_IN_PRINT, (match) =>
            match === "{'@':true}" ? "@" : match === "'...@':true" ? "...@" : match,
          )
        : json;
      return step[0] === "" ? `(${args})` : `${dot}${step[0]}(${args})`;
    })
    .join("");
}

/** Parse an itx-expression prefix (either codec half) — dotted names, optionally pinning literal args
 *  on call steps (`itx.ai.run('gpt-5')`). A call step with NO args pins nothing and is the same prefix
 *  as the plain name, so it is refused: spell `itx.ai.run`. */
export function parseItxExpressionPrefix(source: ItxExpressionInput): ItxExpressionPrefix {
  const expr = toItxExpression(source);
  const spelled = typeof source === "string" ? source : print(expr);
  for (const step of expr) {
    // The ARRAY half enters here un-lexed: a name step must be ONE identifier, exactly what the
    // string half's `readName` accepts — `["itx", "builtins.kv"]` or `["itx", "a b"]` is not a prefix
    // (it would print as a dotted name the door never saw, or as one the reduce cannot parse).
    const name = itxExpressionStepName(step);
    if (name === "")
      throw new Error(`an itx-expression prefix cannot call a result — ${JSON.stringify(spelled)}`);
    if (typeof name !== "string" || IDENT.exec(name)?.[0] !== name)
      throw new Error(
        `an itx-expression prefix's steps are identifiers — ${JSON.stringify(spelled)} has ${JSON.stringify(name)}`,
      );
    if (RESERVED.has(name))
      throw new Error(
        `expression: reserved name ${JSON.stringify(name)} in ${JSON.stringify(spelled)}`,
      );
    if (Array.isArray(step) && step.length === 1)
      throw new Error(
        `an itx-expression prefix pins literal args with a call step — ${JSON.stringify(spelled)} has "${step[0]}()" with none; spell "${step[0]}"`,
      );
  }
  return expr;
}

/** THE ONE canonical spelling of an itx-expression prefix — the rewrite-rule table's key, what a lent
 *  stub is keyed by through `provide`'s sugar: parsed, then printed (dotted names; pinned args as JSON5
 *  literals). */
export function canonicalItxExpressionPrefix(source: ItxExpressionInput): string {
  return print(parseItxExpressionPrefix(source));
}
