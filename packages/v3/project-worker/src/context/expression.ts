// context/expression.ts — THE expression codec: the STRING half (itx.facets.get("core")) ⇄ the
// STRUCTURED half (["itx", "facets", ["get", "core"]]). Args are ONE JSON5 grammar (no hand-rolled
// number/object parser; __proto__-safe); expressions are persisted NAMES, so deleting one IS
// revocation. The rewrite rules (match, rank, rewrite) are ./itx-expression-rewriting.ts; the evaluator
// is ./dispatch.ts.
import JSON5 from "json5";

/** One step: a property read (string) or a call (`[method, ...args]`). Args are plain JSON. The
 *  method `""` is the ANONYMOUS call — call the value itself: `itx.rpcStubs.get('cam')(1, 2)` is
 *  `["itx","rpcStubs",["get","cam"],["",1,2]]` — what a rewrite rule spells when a lent stub is
 *  called with args. */
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
const IDENT = /^[A-Za-z_$][A-Za-z0-9_$-]*/;
const RESERVED = new Set(["__proto__", "constructor", "prototype"]);

// ── `@`, THE CALLER'S INPUT — a rewrite rule's target may hold it, nothing else may ──
// In the string half a bare `@` outside a string literal is the marker (`'@cf/…'` inside quotes is a
// string like any other); `...@` as an object-literal entry is the merge form. In the array half the
// marker is ONE reserved literal, `{ "@": true }`, and the merge entry the key `"...@"` — so the
// stored form is plain JSON, and those two spellings are unspellable as literals in a target (the
// codec's one reservation). What `@` MEANS is rule 7 in ./itx-expression-rewriting.ts; here it is
// only lexed (parse, targets only) and printed back.
const HOLE_KEY = "@";
const MERGE_KEY = "...@";

/** THE one lexer for the marker, both directions: walk `text`, mapping each stretch OUTSIDE single-
 *  or double-quoted string literals through `outside`, and offering each literal (quotes included),
 *  the text after it and the output so far to `literal`, which answers `[newOutput, charsConsumedAfter]`
 *  to rewrite around it or null to keep it verbatim. Escapes are honored; nothing inside a literal is
 *  ever touched. */
function lexStringLiterals(
  text: string,
  outside: (chunk: string) => string,
  literal: (lit: string, after: string, out: string) => [string, number] | null,
): string {
  let out = "";
  for (let i = 0; i < text.length; ) {
    const q = text[i];
    let j = i;
    if (q !== '"' && q !== "'") {
      while (j < text.length && text[j] !== '"' && text[j] !== "'") j++;
      out += outside(text.slice(i, j));
      i = j;
    } else {
      while (++j < text.length && text[j] !== q) if (text[j] === "\\") j++;
      const lit = text.slice(i, j + 1);
      const hit = literal(lit, text.slice(j + 1), out);
      [out, i] = hit ? [hit[0], j + 1 + hit[1]] : [out + lit, j + 1];
    }
  }
  return out;
}

/** Is `value` the marker literal `{ "@": true }`? */
export function isItxExpressionHole(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === 1 &&
    (value as Record<string, unknown>)[HOLE_KEY] === true
  );
}

/** Does `value` (a step, an arg tree, a whole expression) hold the marker or a merge entry anywhere? */
export function containsItxExpressionHole(value: unknown): boolean {
  if (isItxExpressionHole(value)) return true;
  if (Array.isArray(value)) return value.some(containsItxExpressionHole);
  if (value !== null && typeof value === "object")
    return Object.hasOwn(value, MERGE_KEY) || Object.values(value).some(containsItxExpressionHole);
  return false;
}

/** The merge entry's key — `...@` — read by rule 7. */
export const ITX_EXPRESSION_MERGE_KEY = MERGE_KEY;

/** Print's half: in JSON5's output the marker literal is `{'@':true}` and the merge entry
 *  `'...@':true` — spelled with a string literal, so they are matched on literal BOUNDARIES (the
 *  literal `'@'` opening an object and closing it as its only key; the literal `'...@'` as a key). A
 *  user's string that merely contains those characters is a longer literal and never matches. */
const printMarkers = (text: string): string =>
  lexStringLiterals(
    text,
    (chunk) => chunk,
    (lit, after, out) =>
      lit === `'${HOLE_KEY}'` && out.endsWith("{") && after.startsWith(":true}")
        ? [out.slice(0, -1) + "@", ":true}".length]
        : lit === `'${MERGE_KEY}'` && after.startsWith(":true")
          ? [out + "...@", ":true".length]
          : null,
  );

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

/** Parse the STRING half: dotted names + `.method(args)` calls (args JSON5-parsed); rejects reserved
 *  names + bare scope calls. `holes: true` — a rewrite rule's TARGET only — lexes `@` / `...@` into
 *  the marker literals; anywhere else a bare `@` is refused. */
export function parse(source: string, options?: { holes?: boolean }): ItxExpression {
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
      const inner = lexStringLiterals(
        raw,
        (chunk) =>
          chunk.replace(/\.\.\.@|@/g, (m) => {
            if (!options?.holes)
              fail("`@` (the caller's input) is legal only in a rewrite rule's target");
            return m === "@" ? `{"${HOLE_KEY}":true}` : `"${MERGE_KEY}":true`;
          }),
        () => null,
      );
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

/** Object args print with their keys SORTED, so two spellings of one object are one canonical string
 *  — one rewrite-rule row, one facet memo — the way `jsonEqual` already matches them. */
const keySortedForPrint = (_key: string, value: unknown): unknown =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(
        Object.keys(value as Record<string, unknown>)
          .sort()
          .map((k) => [k, (value as Record<string, unknown>)[k]]),
      )
    : value;

/** Canonical stored form: dotted path + `.method(args)` calls (args `JSON5.stringify`d, object keys
 *  sorted; the marker literals print back as `@` / `...@`); `parse(print(e), { holes })` round-trips. */
export function print(expr: ItxExpression): string {
  return expr
    .map((step, i) => {
      const dot = i ? "." : "";
      if (typeof step === "string") return dot + step;
      const args = printMarkers(JSON5.stringify(step.slice(1), keySortedForPrint).slice(1, -1));
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
    if (Array.isArray(step) && step[0] === "")
      throw new Error(`an itx-expression prefix cannot call a result — ${JSON.stringify(spelled)}`);
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
