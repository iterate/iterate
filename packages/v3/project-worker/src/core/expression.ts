// core/expression.ts — THE expression codec: capability calls and capability mounts as data.
//
// One grammar does three jobs:
//   1. a CALL      — "invoke this":  itx.streams.get('/logs').append({ type: 'hi' })
//   2. a PATTERN   — the left side of a mount row: what calls it claims (may contain holes)
//   3. a TARGET    — the right side of a mount row: what to run instead (holes reference caller args)
//
// The op-set is get + call + hole, and NEVER grows (Cap'n Proto kept pipelining to one op for 13
// years; anything smarter belongs in the project's config worker as real code, mounted plainly).
// An expression is a persisted NAME for a capability, never captured authority: every evaluation
// re-derives authority from the scope roots it is handed, so deleting a stored expression IS
// revocation (apps/os's load-bearing rule, kept).
//
// TWO INTERCHANGEABLE HALVES (it is a two-way codec):
//   string     "itx.openai.chat({ model: 'grok-4', messages: ? })"      ← what humans write
//   structured ["itx", "openai", ["chat", { model: "grok-4", messages: { "?": 0 } }]]
// `parse` and `print` round-trip; the structured half is canonical for storage (structurally
// diffable, no re-parsing in folds); the string half is the authoring surface (config, CLI, docs).
//
// HOLES (explicit, never tacit — the Hack-pipes verdict: mark the hole, fail early):
//   ?        positional  → { "?": n }        (auto-numbered left-to-right by the parser)
//   ?0 ?1    ordinal     → { "?": 0 }        (repeatable)
//   ?name    capture     → { "?": "name" }   (pattern side binds it; target side references it)
//   ...?     rest        → { "...": true }   in a call-arg position: splice remaining caller args
//   ...?     spread      → { "...": 0 }      in an object position: shallow-merge caller arg n
//                                            under the frozen keys (frozen wins — the mount is
//                                            the authority)
//   { "$": v }           literal escape: v verbatim (only needed by PROGRAMMATIC writers whose
//                                        data could collide with the tagged shapes above; in the
//                                        string half holes are syntax and can never collide)
//
// MATCHING (the routing table's resolver): a pattern claims a call by binding a prefix of its
// steps. Literals bind harder than holes; longer bound prefixes beat shorter; the table breaks
// exact ties by recency (the shadow stack). The unmatched tail of the call is the REMAINDER,
// replayed on the evaluated target — which is how a bare default route `itx ⇒ itx.cd('/')`
// forwards a whole missed call with zero special machinery.

import { z } from "zod";
import { deeper, jsonEqual } from "./events.ts";

/** One step: a property read (string) or a call (`[method, ...args]`). Args are plain JSON. */
export type Step = string | [method: string, ...args: unknown[]];
export type Expression = Step[];

/** THE structured half as a wire schema — persisted mount rows and APP_CONFIG seeds validate
 *  against this one spelling (two spellings would eventually disagree). */
export const ExpressionSchema = z.array(
  z.union([z.string(), z.tuple([z.string()]).rest(z.unknown())]),
) as z.ZodType<Expression>;

/** A hole/spread/escape marker inside an arg tree (see the header table). */
type Hole = { "?": number | string } | { "...": true | number } | { $: unknown };

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
/** Classify a tagged value — THE one detector every hole walk must share (match, substitute,
 *  the must-use rule): a walker with its own idea of a hole will eventually disagree with
 *  `substitute` about what `$` escapes. */
export const holeKind = (v: unknown): "arg" | "rest" | "literal" | null => {
  if (!isPlainObject(v) || Object.keys(v).length !== 1) return null;
  if ("?" in v) return "arg";
  if ("..." in v) return "rest";
  if ("$" in v) return "literal";
  return null;
};

// ─────────────────────────────────────────────── parse ───────────────────────────────────────────────
// The string half: dotted identifier segments; call parens with JSON5-ish literals (single or
// double quoted strings, numbers, true/false/null, objects, arrays); the hole tokens above.
// Hand-rolled recursive descent — no dependencies (this package is pure-play).

export function parse(source: string): Expression {
  const p = new Parser(source);
  const expr = p.expression();
  p.expectEnd();
  return expr;
}

class Parser {
  #s: string;
  #i = 0;
  #autoArg = 0; // `?` holes are auto-numbered left-to-right across the whole expression

  constructor(s: string) {
    this.#s = s;
  }

  expression(): Expression {
    const steps: Expression = [];
    steps.push(this.#ident());
    for (;;) {
      this.#ws();
      if (this.#peek() === "(") {
        // turn the preceding property step into a call step
        const name = steps.pop();
        if (typeof name !== "string") throw this.#err("call must follow a name");
        if (steps.length === 0)
          throw this.#err("cannot call the scope symbol itself — name a capability first");
        steps.push([name, ...this.#args()]);
      } else if (this.#peek() === ".") {
        this.#i++;
        steps.push(this.#ident());
      } else {
        return steps;
      }
    }
  }

  #args(): unknown[] {
    this.#expect("(");
    const args: unknown[] = [];
    this.#ws();
    if (this.#peek() === ")") {
      this.#i++;
      return args;
    }
    for (;;) {
      args.push(this.#value());
      this.#ws();
      if (this.#peek() === ",") {
        this.#i++;
        continue;
      }
      this.#expect(")");
      return args;
    }
  }

  #depth = 0;

  /** One JSON5-ish value, which may itself be (or contain) a hole. */
  #value(): unknown {
    this.#depth = deeper(this.#depth, "parse");
    try {
      return this.#valueBody();
    } finally {
      this.#depth--;
    }
  }

  #valueBody(): unknown {
    this.#ws();
    const c = this.#peek();
    if (c === "?") return this.#hole();
    if (c === ".") {
      // `...?` — rest (in call args) / spread (in objects); optionally `...?2`
      this.#expect("...");
      this.#expect("?");
      const n = this.#number();
      return n === null ? { "...": true } : { "...": n };
    }
    if (c === "'" || c === '"') return this.#string(c);
    if (c === "{") return this.#object();
    if (c === "[") return this.#array();
    if (c === "-" || (c >= "0" && c <= "9")) {
      const n = this.#number();
      if (n === null) throw this.#err("number expected");
      return n;
    }
    const word = this.#word();
    if (word === "true") return true;
    if (word === "false") return false;
    if (word === "null") return null;
    throw this.#err(`unexpected value ${JSON.stringify(word || c)}`);
  }

  #hole(): Hole {
    this.#expect("?");
    const n = this.#number();
    if (n !== null) return { "?": n }; // ?0 ordinal
    const name = this.#word();
    if (name) return { "?": name }; // ?name capture
    return { "?": this.#autoArg++ }; // ? positional (auto-numbered)
  }

  #object(): Record<string, unknown> {
    this.#expect("{");
    const out: Record<string, unknown> = {};
    this.#ws();
    if (this.#peek() === "}") {
      this.#i++;
      return out;
    }
    for (;;) {
      this.#ws();
      if (this.#peek() === ".") {
        // `...?` spread entry — stored under the reserved "..." key
        this.#expect("...");
        this.#expect("?");
        out["..."] = this.#number() ?? 0;
      } else {
        const q = this.#peek();
        const key = q === "'" || q === '"' ? this.#string(q) : this.#word();
        this.#ws();
        this.#expect(":");
        out[key] = this.#value();
      }
      this.#ws();
      if (this.#peek() === ",") {
        this.#i++;
        continue;
      }
      this.#expect("}");
      return out;
    }
  }

  #array(): unknown[] {
    this.#expect("[");
    const out: unknown[] = [];
    this.#ws();
    if (this.#peek() === "]") {
      this.#i++;
      return out;
    }
    for (;;) {
      out.push(this.#value());
      this.#ws();
      if (this.#peek() === ",") {
        this.#i++;
        continue;
      }
      this.#expect("]");
      return out;
    }
  }

  #string(quote: string): string {
    this.#expect(quote);
    let out = "";
    while (this.#i < this.#s.length) {
      const c = this.#s[this.#i++];
      if (c === quote) return out;
      if (c === "\\") {
        const e = this.#s[this.#i++];
        out += e === "n" ? "\n" : e === "t" ? "\t" : e; // \' \" \\ \n \t
      } else out += c;
    }
    throw this.#err("unterminated string");
  }

  #number(): number | null {
    const m = /^-?\d+(\.\d+)?/.exec(this.#s.slice(this.#i));
    if (!m) return null;
    this.#i += m[0].length;
    return Number(m[0]);
  }

  #ident(): string {
    this.#ws();
    const w = this.#word();
    if (!w) throw this.#err("name expected");
    if (w === "__proto__" || w === "constructor" || w === "prototype")
      throw this.#err(`reserved name "${w}"`);
    return w;
  }

  #word(): string {
    const m = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(this.#s.slice(this.#i));
    if (!m) return "";
    this.#i += m[0].length;
    return m[0];
  }

  #ws() {
    while (this.#i < this.#s.length && /\s/.test(this.#s[this.#i])) this.#i++;
  }
  #peek(): string {
    this.#ws();
    return this.#s[this.#i] ?? "";
  }
  #expect(tok: string) {
    this.#ws();
    if (!this.#s.startsWith(tok, this.#i)) throw this.#err(`expected "${tok}"`);
    this.#i += tok.length;
  }
  expectEnd() {
    this.#ws();
    if (this.#i < this.#s.length) throw this.#err("trailing input");
  }
  #err(msg: string): Error {
    return new Error(
      `expression parse error at ${this.#i}: ${msg} — in ${JSON.stringify(this.#s)}`,
    );
  }
}

/** Accept either half anywhere an expression is accepted; normalize to the structured form. */
export function toExpression(input: string | Expression): Expression {
  return typeof input === "string" ? parse(input) : input;
}

// ─────────────────────────────────────────────── print ───────────────────────────────────────────────

/** Canonical string form (single quotes, minimal spacing). `parse(print(e))` round-trips. */
export function print(expr: Expression): string {
  return expr
    .map((step, i) => {
      const dot = i === 0 ? "" : ".";
      if (typeof step === "string") return dot + step;
      const [method, ...args] = step;
      return `${dot}${method}(${args.map(printValue).join(", ")})`;
    })
    .join("");
}

function printValue(v: unknown): string {
  switch (holeKind(v)) {
    case "arg":
      return `?${(v as { "?": number | string })["?"]}`;
    case "rest": {
      const n = (v as { "...": true | number })["..."];
      return n === true ? "...?" : `...?${n}`;
    }
    case "literal":
      return printValue((v as { $: unknown }).$);
  }
  if (typeof v === "string") return `'${v.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
  if (Array.isArray(v)) return `[${v.map(printValue).join(", ")}]`;
  if (isPlainObject(v))
    return `{ ${Object.entries(v)
      .map(([k, val]) => (k === "..." ? printValue({ "...": val }) : `${k}: ${printValue(val)}`))
      .join(", ")} }`;
  return JSON.stringify(v);
}

// ─────────────────────────────────────────────── match ───────────────────────────────────────────────

/** A successful claim of `call` by `pattern`. */
export type Match = {
  /** Per-step scores, literal-heavier is bigger; compare with `compareSpecificity`. */
  specificity: number[];
  /** Values bound by `?name` captures in the pattern. */
  captures: Record<string, unknown>;
  /** The call's invocation args at the boundary, when the matched call step carried args the
   *  pattern did not consume (pattern `itx.grok` vs call `itx.grok({...})`). */
  boundaryArgs?: unknown[];
  /** The call's unmatched tail, replayed on the evaluated target. */
  remainder: Expression;
};

/**
 * Try to claim `call` with `pattern`. Rules:
 *  - a string pattern step matches a string call step of the same name, or — at the FINAL pattern
 *    step only — a call step of the same method (consuming the name; the args become boundaryArgs);
 *  - a call pattern step `[m, ...pargs]` matches a call step `[m, ...cargs]` by unifying args:
 *    literals must deep-equal, `?`-holes bind anything (captures record it), `...?` binds the rest;
 *    without a rest hole the arities must be equal;
 *  - specificity per step: 1 for a name bind, +1 per literal arg bound (holes add nothing).
 */
export function match(pattern: Expression, call: Expression): Match | null {
  const specificity: number[] = [];
  const captures: Record<string, unknown> = {};
  let boundaryArgs: unknown[] | undefined;

  for (let i = 0; i < pattern.length; i++) {
    const p = pattern[i];
    const c = call[i];
    if (c === undefined) return null; // pattern longer than call
    if (typeof p === "string") {
      if (typeof c === "string") {
        if (p !== c) return null;
        specificity.push(1);
      } else {
        if (c[0] !== p || i !== pattern.length - 1) return null; // name-only consume: final step only
        boundaryArgs = c.slice(1);
        specificity.push(1);
      }
    } else {
      if (typeof c === "string" || c[0] !== p[0]) return null;
      const pargs = p.slice(1);
      const cargs = c.slice(1);
      let score = 1;
      const rest = pargs.findIndex((a) => holeKind(a) === "rest");
      if (rest === -1 && pargs.length !== cargs.length) return null;
      if (rest !== -1 && cargs.length < rest) return null;
      const n = rest === -1 ? pargs.length : rest;
      for (let j = 0; j < n; j++) {
        const kind = holeKind(pargs[j]);
        if (kind === "arg") {
          const h = (pargs[j] as { "?": number | string })["?"];
          if (typeof h === "string") captures[h] = cargs[j];
        } else if (jsonEqual(unliteral(pargs[j]), cargs[j])) {
          score += 1;
        } else return null;
      }
      specificity.push(score);
    }
  }
  return { specificity, captures, boundaryArgs, remainder: call.slice(pattern.length) };
}

/** Longest-bound-prefix, literal-beats-hole ordering. Returns >0 when `a` is more specific. */
export function compareSpecificity(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? -1) - (b[i] ?? -1);
    if (d !== 0) return d;
  }
  return 0;
}

const unliteral = (v: unknown): unknown =>
  holeKind(v) === "literal" ? (v as { $: unknown }).$ : v;

// ────────────────────────────────────────────── substitute ──────────────────────────────────────────────

/**
 * Make a target expression concrete: replace every hole with the caller's values.
 *  - `{ "?": n }`      → args[n]           (missing → undefined, like JS)
 *  - `{ "?": "name" }` → captures[name]    (unbound capture → registration bug, throws)
 *  - `{ "...": true }` in a call-arg list  → splice args from (highest numbered hole in that
 *                                            list)+1, or all args when none are numbered
 *  - `{ "...": n }` in an object           → shallow-merge args[n] (must be an object) under the
 *                                            frozen keys — FROZEN WINS
 *  - `{ "$": v }`      → v verbatim
 */
export function substitute(
  target: Expression,
  ctx: { args: unknown[]; captures: Record<string, unknown> },
): Expression {
  return target.map((step) =>
    typeof step === "string" ? step : ([step[0], ...substituteArgList(step.slice(1), ctx)] as Step),
  );
}

function substituteArgList(
  list: unknown[],
  ctx: { args: unknown[]; captures: Record<string, unknown> },
): unknown[] {
  // The highest numbered `?n` ANYWHERE in the list (nested in objects/arrays too — a hole inside
  // `{ a: ?0 }` spends args[0] just as a top-level one does; scanning only the top level would
  // make `f({ a: ?0 }, ...?)` splice args[0] twice). `$`-escaped data is not a hole.
  let highest = -1;
  const scan = (v: unknown, depth: number): void => {
    if (typeof v !== "object" || v === null) return;
    const kind = holeKind(v);
    if (kind === "arg") {
      const h = (v as { "?": number | string })["?"];
      if (typeof h === "number") highest = Math.max(highest, h);
      return;
    }
    if (kind === "literal" || kind === "rest") return;
    for (const inner of Object.values(v)) scan(inner, deeper(depth, "hole scan"));
  };
  for (const v of list) scan(v, 0);
  const out: unknown[] = [];
  for (const v of list) {
    if (holeKind(v) === "rest" && (v as { "...": true | number })["..."] === true) {
      out.push(...ctx.args.slice(highest + 1));
    } else out.push(substituteValue(v, ctx));
  }
  return out;
}

function substituteValue(
  v: unknown,
  ctx: { args: unknown[]; captures: Record<string, unknown> },
  depth = 0,
): unknown {
  switch (holeKind(v)) {
    case "arg": {
      const h = (v as { "?": number | string })["?"];
      if (typeof h === "number") return ctx.args[h];
      if (!(h in ctx.captures)) throw new Error(`unbound capture "?${h}" — pattern never bound it`);
      return ctx.captures[h];
    }
    case "literal":
      return (v as { $: unknown }).$;
    case "rest":
      break; // object-spread handled below; bare rest outside a call list is meaningless
  }
  if (Array.isArray(v)) return v.map((x) => substituteValue(x, ctx, deeper(depth, "substitute")));
  if (isPlainObject(v)) {
    const spreadArg = "..." in v && Object.keys(v).length >= 1 ? (v["..."] as number) : undefined;
    const out: Record<string, unknown> = {};
    if (spreadArg !== undefined) {
      const src = ctx.args[spreadArg];
      if (!isPlainObject(src))
        throw new Error(`...?${spreadArg} spread: caller arg is not an object`);
      Object.assign(out, src);
    }
    for (const [k, val] of Object.entries(v)) {
      if (k === "...") continue;
      out[k] = substituteValue(val, ctx, deeper(depth, "substitute")); // frozen keys overwrite spread — frozen wins
    }
    return out;
  }
  return v;
}

// ─────────────────────────────────────────────── evaluate ───────────────────────────────────────────────

// The RPC exposure doctrine (Kenton, workerd PR #1028), enforced at THE dispatch point — the
// parser's name blacklist is client-side convenience that the structured-Expression and dotted
// invokeCapability doors bypass: what every object merely INHERITS from Object/Function.prototype
// is not capability surface, and the three magic names never resolve. Refusal is
// indistinguishable from absence (same behavior as a missing step), so callers cannot probe.
// Identity-based on purpose, never a descriptor walk: views may be Proxies (pathProxy, capnweb /
// Workers-RPC stubs) whose descriptor traps don't mirror `get`. An own/override with the same
// name resolves to a DIFFERENT function and passes — the doctrine allows what the object chose.
const INHERITED_BUILTINS = new Set<unknown>(
  [Object.prototype, Function.prototype].flatMap((proto) =>
    Object.getOwnPropertyNames(proto)
      .map((k) => Object.getOwnPropertyDescriptor(proto, k)?.value)
      .filter((v) => typeof v === "function"),
  ),
);
/** Resolve one step's property as capability surface — `undefined` for anything only inherited. */
export function stepGet(value: object, key: string): unknown {
  if (key === "__proto__" || key === "constructor" || key === "prototype") return undefined;
  const resolved = Reflect.get(value, key);
  return INHERITED_BUILTINS.has(resolved) ? undefined : resolved;
}

/**
 * THE step walk (shared by `evaluate` and `apply`): property steps `Reflect.get` with the
 * receiver carried; call steps `Reflect.apply` ON that receiver (detaching a method from a
 * Workers-RPC receiver breaks it); every step is awaited so stub-returning calls pipeline
 * naturally. `where` names the walk in errors (`expression` / `remainder`).
 */
async function walkSteps(
  start: { value: unknown; receiver: unknown },
  steps: Expression,
  where: string,
): Promise<{ value: unknown; receiver: unknown }> {
  let { value, receiver } = start;
  for (const step of steps) {
    value = await value;
    if (value == null) throw new Error(`${where} hit ${String(value)} at ${JSON.stringify(step)}`);
    if (typeof step === "string") {
      receiver = value;
      value = stepGet(value as object, step);
    } else {
      const [method, ...args] = step;
      const fn = stepGet(value as object, method);
      if (typeof fn !== "function")
        throw new Error(`${where}: ${JSON.stringify(method)} is not a method`);
      receiver = undefined;
      value = await Reflect.apply(fn, value, args);
    }
  }
  return { value: await value, receiver };
}

/**
 * Walk a CONCRETE expression (no holes — `substitute` first) against named scope roots. The first
 * step names a root (`itx`, and `roots` for config-provenance expressions — evaluation for event
 * provenance simply does not have `roots` in scope: unspellable, not policed).
 */
export async function evaluate(
  scope: Record<string, unknown>,
  expr: Expression,
): Promise<{ value: unknown; receiver: unknown }> {
  const [root, ...steps] = expr;
  if (typeof root !== "string" || !(root in scope))
    throw new Error(`expression root ${JSON.stringify(root)} is not in scope`);
  return walkSteps({ value: scope[root], receiver: undefined }, steps, "expression");
}

/**
 * Finish a matched call: evaluate the (already substituted) target, then replay the remainder on
 * the result. Boundary args (caller invoked at the mount itself) apply the evaluated value as a
 * function on its carried receiver — and if it is not callable that is a LOUD error (never the
 * silent arg-drop apps/os shipped).
 */
export async function apply(
  scope: Record<string, unknown>,
  target: Expression,
  m: Pick<Match, "boundaryArgs" | "remainder">,
  /** Runtime values applied to the FINAL value (after the remainder walk) on its carried
   *  receiver — the fetch lane hands the live Request in here, since a Request is not
   *  expression data and must never pass through `substitute`'s JSON walk. */
  extraArgs?: unknown[],
): Promise<unknown> {
  let { value, receiver } = await evaluate(scope, target);
  if (m.boundaryArgs) {
    if (typeof value !== "function")
      throw new Error(
        `mount target is not callable but the call passed ${m.boundaryArgs.length} arg(s) — ` +
          `did the target forget a hole (?) for them?`,
      );
    value = await Reflect.apply(value, receiver, m.boundaryArgs);
  }
  ({ value, receiver } = await walkSteps({ value, receiver }, m.remainder, "remainder"));
  if (extraArgs) {
    if (typeof value !== "function")
      throw new Error(
        `the resolved value is not callable but ${extraArgs.length} runtime arg(s) were passed`,
      );
    value = await Reflect.apply(value, receiver, extraArgs);
  }
  return await value;
}

/** Does this target expression consume the caller's invocation args (numeric/rest/spread holes)?
 *  If yes, `substitute` spends the boundary args and `apply` must not re-apply them; if no, the
 *  boundary args apply to the evaluated value itself (a plain function/method alias). */
export function usesCallerArgs(expr: Expression): boolean {
  let found = false;
  const walk = (v: unknown): void => {
    if (found || typeof v !== "object" || v === null) return;
    const kind = holeKind(v);
    if (kind === "arg") {
      if (typeof (v as { "?": number | string })["?"] === "number") found = true;
      return;
    }
    if (kind === "rest") {
      found = true;
      return;
    }
    if (kind === "literal") return; // escaped user data — never a hole
    // an object-SPREAD is a "..." key on a (possibly multi-key) object, not a single-key tag
    if (!Array.isArray(v) && "..." in (v as Record<string, unknown>)) {
      found = true;
      return;
    }
    for (const inner of Object.values(v)) walk(inner);
  };
  for (const step of expr) if (Array.isArray(step)) step.slice(1).forEach(walk);
  return found;
}

/** The dotted surface as a runtime Proxy — the programmatic write-half of the codec: property
 *  gets accumulate path segments, calling hands `(segments, args)` to `call`. `then`/symbol
 *  probes return undefined so a proxy is never mistaken for a thenable mid-await. ONE builder
 *  for every dotted view (the itx scope symbol, the facet clients view, the stateful-worker
 *  proxy) — they differed only in what the terminal apply dispatches to. Calling the BARE root
 *  is a loud error (mirroring the parser), so `call` always receives ≥1 segment. */
export function pathProxy(call: (segments: string[], args: unknown[]) => unknown): unknown {
  const build = (segments: string[]): unknown =>
    new Proxy(function () {} as object, {
      get: (_t, p) =>
        p === "then" || typeof p === "symbol" ? undefined : build([...segments, p as string]),
      apply: (_t, _this, args) => {
        if (segments.length === 0)
          throw new Error("cannot call the scope symbol itself — name a capability first");
        return call(segments, args as unknown[]);
      },
    });
  return build([]);
}
