// core/expression.ts — THE expression codec: capability calls and capability-mount targets as
// data, plus the capability-path matcher.
//
// Two grammars, deliberately unequal:
//   1. an EXPRESSION — a call written down: itx.streams.get('/logs').append({ type: 'hi' }).
//      The op-set is get + call and NEVER grows (Cap'n Proto kept pipelining to one op for 13
//      years; anything smarter belongs in the project's config worker as real code, mounted
//      plainly). An expression is a persisted NAME for a callable, never captured authority:
//      every evaluation re-derives authority from the scope it is handed, so deleting a stored
//      expression IS revocation (apps/os's load-bearing rule, kept).
//   2. a CAPABILITY PATH — the left side of a capability mount: a plain dotted path
//      ("itx.subscribers.foo"). Matching is longest-path-prefix; the path's FINAL segment may
//      consume a call's arguments (they become the boundary args); everything after the matched
//      capability reference is the REMAINDER, replayed on the evaluated target. There are no
//      placeholders, captures, or argument-unification in patterns — that generality had zero
//      users and shipped two codec bugs before it was deleted (increment 55); argument-shaping
//      belongs in a code capability.
//
// STRING AT REST, STRUCTURED IN MEMORY: event payloads and config store the STRING half (what
// humans read in the log); `parse` runs once when a reduce rehydrates its table; `print`
// canonicalizes programmatically built expressions into the stored string form at mount time.

import { z } from "zod";
import { deeper } from "./events.ts";

/** One step: a property read (string) or a call (`[method, ...args]`). Args are plain JSON. */
export type Step = string | [method: string, ...args: unknown[]];
export type Expression = Step[];

/** The structured half as a wire schema — reduced-state checkpoints validate against this one
 *  spelling (events store the STRING half). */
export const ExpressionSchema = z.array(
  z.union([z.string(), z.tuple([z.string()]).rest(z.unknown())]),
) as z.ZodType<Expression>;

/** A capability path — the left side of a mount. Plain dotted segments, no calls, no args. */
export type CapabilityPath = string[];

/** Parse a capability path ("itx.subscribers.foo") — the string must be dotted names only. */
export function parseCapabilityPath(source: string): CapabilityPath {
  const expr = parse(source);
  if (!expr.every((step): step is string => typeof step === "string"))
    throw new Error(
      `a capability path is dotted names only — ${JSON.stringify(source)} contains a call`,
    );
  return expr;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

// ─────────────────────────────────────────────── parse ───────────────────────────────────────────────
// The string half: dotted identifier segments; call parens with JSON5-ish literals (single or
// double quoted strings, numbers, true/false/null, objects, arrays). Hand-rolled recursive
// descent — no dependencies (this package is pure-play).

export function parse(source: string): Expression {
  const p = new Parser(source);
  const expr = p.expression();
  p.expectEnd();
  return expr;
}

class Parser {
  #s: string;
  #i = 0;

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

  /** One JSON5-ish value. */
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
      const q = this.#peek();
      const key = q === "'" || q === '"' ? this.#string(q) : this.#word();
      this.#ws();
      this.#expect(":");
      out[key] = this.#value();
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
    // Hyphens are legal in non-leading position: kebab-case slugs ("capability-table",
    // "user-tally") are path segments throughout the platform, and this grammar has no binary
    // minus to collide with (a number's minus is consumed by the value branch first).
    const m = /^[A-Za-z_$][A-Za-z0-9_$-]*/.exec(this.#s.slice(this.#i));
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

/** Canonical string form (single quotes, minimal spacing) — THE stored form: `print` runs at
 *  mount time to canonicalize programmatically built expressions into what the event carries.
 *  `parse(print(e))` round-trips. */
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
  if (typeof v === "string") return `'${v.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
  if (Array.isArray(v)) return `[${v.map(printValue).join(", ")}]`;
  if (isPlainObject(v))
    return `{ ${Object.entries(v)
      .map(([k, val]) => `${k}: ${printValue(val)}`)
      .join(", ")} }`;
  return JSON.stringify(v);
}

// ─────────────────────────────────────────────── match ───────────────────────────────────────────────

/** A successful claim of `call` by a capability path. */
export type Match = {
  /** THE WHOLE RANKING RULE: the longest matching path wins; ties go to the newest mount. */
  matchedSegments: number;
  /** The call's invocation args at the boundary, when the FINAL path segment matched a call
   *  step (path `itx.grok` vs call `itx.grok({...})`) — applied to the evaluated target. */
  boundaryArgs?: unknown[];
  /** The call's unmatched tail, replayed on the evaluated target. */
  remainder: Expression;
};

/** Try to claim `call` with a capability path: each segment matches a string step of the same
 *  name, or — FINAL segment only — a call step of the same method (its args become the
 *  boundary args). */
export function match(path: readonly string[], call: Expression): Match | null {
  let boundaryArgs: unknown[] | undefined;
  for (let i = 0; i < path.length; i++) {
    const c = call[i];
    if (c === undefined) return null; // path longer than the call
    if (typeof c === "string") {
      if (c !== path[i]) return null;
    } else {
      if (c[0] !== path[i] || i !== path.length - 1) return null; // call consume: final segment only
      boundaryArgs = c.slice(1);
    }
  }
  return { matchedSegments: path.length, boundaryArgs, remainder: call.slice(path.length) };
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
 * Dotted-path invocation over a LOCAL object graph — a facet stub, a hosted class, any dotted
 * view: walk the intermediates receiver-preservingly, apply the terminal. ONE walk for every
 * "call path X with args on this object" door (the parent's facetInvoke, the stateful runner);
 * the hand-rolled copies it replaced were the drift class.
 *
 * ⚠️  THE DataCloneError LEARNING LIVES HERE — invoke facet/RPC-stub methods with
 * `Reflect.apply(fn, receiver, args)`, NEVER `stub[m].apply(stub, args)`: reading `.apply` off
 * an RPC stub's method proxy is a capnweb PIPELINED REMOTE PATH; calling it passes the stub as
 * an argument, so workerd serializes it — and a Worker-Loader facet stub may never be
 * serialized (`requireAllowsTransfer()` throws unconditionally) → `DataCloneError: Durable
 * Object Facet stubs cannot be transferred between Workers`. walkSteps above does exactly the
 * safe thing (stepGet + Reflect.apply, receiver carried); do not "simplify" it away. This one
 * idiom cost a full investigation — see FACET-RPC-INVESTIGATION.md.
 */
export async function invokePath(
  target: unknown,
  path: string[],
  args: unknown[],
  where: string,
): Promise<unknown> {
  const steps = [...path.slice(0, -1), [path.at(-1)!, ...args]] as Expression;
  return (await walkSteps({ value: target, receiver: undefined }, steps, where)).value;
}

/**
 * Walk a CONCRETE expression against named scope roots. The first step names a root (`itx`,
 * and the built-ins for config-provenance targets — evaluation for event provenance simply
 * does not have the built-ins in scope: unspellable, not policed).
 */
export async function evaluate(
  scope: Record<string, unknown>,
  expr: Expression,
): Promise<{ value: unknown; receiver: unknown }> {
  const [root, ...steps] = expr;
  // Object.hasOwn, not `in`: scope absence IS the provenance gate, and the `in` operator would
  // leak Object.prototype names as phantom roots.
  if (typeof root !== "string" || !Object.hasOwn(scope, root))
    throw new Error(`expression root ${JSON.stringify(root)} is not in scope`);
  return walkSteps({ value: scope[root], receiver: undefined }, steps, "expression");
}

/**
 * Finish a matched call: evaluate the target, apply the boundary args (caller invoked at the
 * mount itself) on the carried receiver, then replay the remainder on the result. A
 * non-callable target receiving boundary args is a LOUD error (never the silent arg-drop
 * apps/os shipped).
 */
export async function apply(
  scope: Record<string, unknown>,
  target: Expression,
  m: Pick<Match, "boundaryArgs" | "remainder">,
  /** Runtime values applied to the FINAL value (after the remainder walk) on its carried
   *  receiver — the fetch lane hands the live Request in here, since a Request is not
   *  expression data. */
  extraArgs?: unknown[],
): Promise<unknown> {
  let { value, receiver } = await evaluate(scope, target);
  if (m.boundaryArgs) {
    if (typeof value !== "function")
      throw new Error(
        `mount target is not callable but the call passed ${m.boundaryArgs.length} arg(s)`,
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

/** The dotted surface as a runtime Proxy — the programmatic write-half of the codec: property
 *  gets accumulate path segments, calling hands `(segments, args)` to `call`. `then`/symbol
 *  probes return undefined so a proxy is never mistaken for a thenable mid-await. ONE builder
 *  for every dotted view. Calling the BARE root is a loud error (mirroring the parser), so
 *  `call` always receives ≥1 segment — except a PROVIDER proxy (allowRootCall), where a parked
 *  bare callback IS the callable. */
export function pathProxy(
  call: (segments: string[], args: unknown[]) => unknown,
  opts?: { allowRootCall?: boolean },
): unknown {
  const build = (segments: string[]): unknown =>
    new Proxy(function () {} as object, {
      get: (_t, p) =>
        p === "then" || typeof p === "symbol" ? undefined : build([...segments, p as string]),
      apply: (_t, _this, args) => {
        if (segments.length === 0 && !opts?.allowRootCall)
          throw new Error("cannot call the scope symbol itself — name a capability first");
        return call(segments, args as unknown[]);
      },
    });
  return build([]);
}
