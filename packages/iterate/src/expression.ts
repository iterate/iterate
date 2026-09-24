// expression.ts — THE expression codec: the STRING half (itx.facets.get("core")) ⇄ the
// STRUCTURED half (["itx", "facets", ["get", "core"]]). Args are ONE JSON5 grammar, comments included
// (no hand-rolled number/object parser; __proto__-safe); expressions are persisted NAMES, so deleting
// one IS revocation. One more concept rides with the codec, because user code speaks it too:
//   invoke handle — `InvokeHandle` + the prototype hop: the DOTTED SURFACE, every unknown chain one
//                   `invoke(expression)` — what `itx.facets.get(name)` and every other mid-chain
//                   capability of api.ts is, and what a connector builds over a remote API
// What the PLATFORM does with an expression is apps/os: the rewrite rules (match, rank, rewrite) are
// src/context/itx-expression-rewriting.ts, and executing a rewritten call against a live object graph
// (`walkSteps`, the answer a context hands back) is src/context/dispatch.ts.
import JSON5 from "json5";
import { RpcTarget } from "capnweb";
import { codedError, jsonEqual } from "./lib.ts";

/** A STRING expression is for what a person types: short. Anything bigger — a worker's source, a large
 *  literal — rides the PARSED form (`["itx","workers",["get",{ source }]]`), which is plain data and never
 *  meets json5. The cap is O(1), before any parsing (stock json5 allocates per character and a
 *  multi-megabyte literal kills a 128 MiB isolate). */
const ITX_EXPRESSION_STRING_MAX_CHARS = 2048;

/** One step: a property read (string) or a call (`[method, ...args]`). Args are plain JSON. The
 *  method `""` is the ANONYMOUS call — call the value itself: `itx.builtins.rpcStubs.get('cam')(1, 2)`
 *  is `["itx","builtins","rpcStubs",["get","cam"],["",1,2]]` — what a `provide(stub)` rule spells when
 *  the lent stub is called with args. */
export type ItxExpressionStep = string | [method: string, ...args: unknown[]];
/** An itx expression as data: the scope root (`itx`) then get/call steps. THE parsed form every
 *  dispatching method works on. */
export type ItxExpression = ItxExpressionStep[];
/** THE dispatch target, in EITHER codec half — a dotted string that starts with the scope root
 *  (`"itx.facets.get('core')"`) OR the parsed structured form (`["itx","facets",["get","core"]]`).
 *  Both carry call args (the string via `.method(args)`), and `normalizedItxExpression` normalizes
 *  either to the structured form — so either works wherever one works, in every method that dispatches. */
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
// target (the codec's one reservation). What `@` MEANS is `fillItxExpressionHoles` in
// apps/os/src/context/itx-expression-rewriting.ts; here it is only lexed (parse, targets only) and
// printed back (print, targets only).
/** The marker's array-half spelling, the one reserved literal. */
const ITX_EXPRESSION_HOLE = { "@": true } as const;
/** The merge entry's key — `...@` — read by apps/os `fillItxExpressionHoles`. */
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
  // oxlint-disable-next-line iterate/simple-truthiness-check -- `value` is `unknown`; the typeof separates real objects from primitives (a bare truthiness check would recurse into strings/numbers)
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

/** The array half, checked the way the parser checks the string half — every name step an identifier
 *  that is not reserved, every call step `[method, ...args]` with an identifier method (or `""`, the
 *  anonymous call, only right after a call) — WITHOUT printing and re-parsing: a stored target carries a worker's whole source as
 *  data, and that data must never meet the string codec (the 2 KiB cap, json5). Throws in the
 *  parser's words. */
function assertItxExpressionShape(expression: ItxExpression): void {
  const fail = (m: string): never => {
    throw new Error(`expression: ${m} in ${JSON.stringify(expression).slice(0, 200)}`);
  };
  // oxlint-disable-next-line iterate/simple-truthiness-check -- runtime shape validation of wire/stored data; the ItxExpression array type is a claim here, not a guarantee
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
    // oxlint-disable-next-line iterate/simple-truthiness-check -- runtime shape validation of wire/stored data; the step's static array type is a claim here, not a guarantee
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

/** THE ONE NORMALIZER: either half, normalized to the array half and checked — a string is
 *  parsed (short by rule), an array is shape-checked in place. Every function that takes an
 *  `ItxExpressionInput` (the edge `invoke`, the resolver, the event builders, the prefix parser
 *  below) enters through it. */
export function normalizedItxExpression(
  input: ItxExpressionInput,
  options?: { holes?: boolean },
): ItxExpression {
  if (typeof input === "string") return parse(input, options);
  assertItxExpressionShape(input);
  return input;
}

/** Object args print with their keys SORTED, so two spellings of one object are one canonical string
 *  — one rewrite-rule row, one facet memo, one library connection memo (library.ts) — the way
 *  `jsonEqual` already matches them. A `JSON.stringify` / `JSON5.stringify` replacer. */
export const keySortedForPrint = (_key: string, value: unknown): unknown =>
  // oxlint-disable-next-line iterate/simple-truthiness-check -- `value` is `unknown` (a JSON replacer arg); the typeof discriminates real objects from primitive values
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

/** Parse an itx-expression prefix (either codec half) — `normalizedItxExpression` (so every step is
 *  an identifier that is not reserved, in either half) plus the two refusals only a PREFIX has: the
 *  anonymous call step (`f(x)(y)` — a prefix cannot call a result), and a call step with NO args,
 *  which pins nothing and is the same prefix as the plain name: spell `itx.ai.run`. */
export function parseItxExpressionPrefix(source: ItxExpressionInput): ItxExpressionPrefix {
  const expr = normalizedItxExpression(source);
  const spelled = typeof source === "string" ? source : print(expr);
  for (const step of expr) {
    if (!Array.isArray(step)) continue;
    if (step[0] === "")
      throw new Error(`an itx-expression prefix cannot call a result — ${JSON.stringify(spelled)}`);
    if (step.length === 1)
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

// ── invoke handle ── THE DOTTED SURFACE: how a surface that declares only fixed methods is
// spoken as deep dotted access (`itx.slack.chat.postMessage({...})`), every unknown segment
// accumulating into ONE `invoke(expression)` dispatch, `[...root, ...prefix, [method, ...args]]`.
// Declared members always win. The pieces: the reserved names, the function-backed PATH PROXY, the
// PROTOTYPE HOP that installs the fallback on a class, `InvokeHandle` (the genuine RpcTarget a
// mid-chain capability is handed back as), and `walkStepsOnRpcStub`.
//
// WHY A PROTOTYPE HOP AND NOT A PROXY AROUND THE INSTANCE (tried FIRST and reverted): workerd RPC
// classifies a call's RESULT for promise pipelining with native brand checks a JS Proxy can never
// pass (`serializeJsValueWithPipeline` in worker-rpc.c++ → `NonPipelinable`; cloudflare/workerd#6873).
// So a surface returned FROM A METHOD must hand back a REAL, unproxied instance or every pipelined
// call on it dies with "The RPC receiver does not implement the method ...". A mid-chain call
// returns its handle ACROSS an RPC boundary (`itx.facets.get('b').hello()` is two dispatches), and
// capnweb's RpcTarget IS the native `cloudflare:workers` RpcTarget on workerd, so a real RpcTarget
// passes on both hops. The hop squares that with dynamic dispatch by inserting one proxied link
// BETWEEN `Class.prototype` and its parent:
//
//   instance ──proto──▶ Class.prototype ──proto──▶ Proxy(hop) ──proto──▶ parent
//
// - The instance is a genuine, natively-branded RpcTarget → the pipeline classifier accepts it.
// - Declared members resolve BEFORE the hop — built-ins win, so a dynamic capability can never
//   shadow a declared name (the deliberate trade-off).
// - Unknown string keys reach the hop's `get` trap and become path proxies, dispatched via the
//   receiver's own `invoke`; the receiver IS the invoker, so it wires with zero glue.
// - Instances stay clean of own properties, so Workers RPC's instance-property protection needs
//   no `getOwnPropertyDescriptor` help.
//
// KNOWN QUIRKS: no `has` trap on the hop, so `"x" in instance`
// reflects DECLARED members only while `instance.x` conjures a dispatcher — feature-detect with
// access, not `in`; a typo'd built-in (`itx.strems`) is a syntactically valid dynamic dispatch that
// fails at the capability table, not a crisp missing-method error.
//
// apps/os's library tier (src/library.ts) builds its connectors on this section and the codec, as a
// userspace worker would (library.test.ts pins that).

/** The dispatch method every dotted miss collapses onto. `IterateContextRpcTarget` implements it directly (root
 *  `itx`); a mid-chain `InvokeHandle` implements it relative to itself (empty root). */
type InvokeTarget = {
  invoke(itxExpression: ItxExpression): unknown;
};

/** Names that must NEVER become dynamic capability segments — a dispatcher answering them would turn
 *  a plain property probe into a live capability call. Enforced at the prototype-chain hop and at
 *  every depth of the path proxies it hands out. Two kinds, one set: */
const RESERVED_SEGMENT_NAMES: ReadonlySet<string> = new Set([
  // JS/RPC protocol machinery a framework or capnweb probes on any object (`then` above all: an
  // instance must never look thenable, or every `await` of it would resolve a capability).
  "__defineGetter__",
  "__defineSetter__",
  "__lookupGetter__",
  "__lookupSetter__",
  "__proto__",
  "apply",
  "bind",
  "call",
  "catch",
  "constructor",
  "dup",
  "finally",
  "hasOwnProperty",
  "isPrototypeOf",
  "map",
  "onRpcBroken",
  "propertyIsEnumerable",
  "prototype",
  "then",
  "toLocaleString",
  "toString",
  "valueOf",
  // Names common protocols LOOK UP on arbitrary objects and CALL if callable: JSON.stringify
  // (toJSON) and vitest/jest equality (asymmetricMatch). The asymmetricMatch case is worse than
  // noise — vitest treats any object with a callable asymmetricMatch as an asymmetric matcher, and
  // a dispatcher returning a (truthy) Promise makes the equality SPURIOUSLY PASS. The bar for this
  // half is HIGH (these names become unreachable as dotted segments; explicit invoke still
  // reaches them): probed-and-called by ubiquitous protocols AND implausible as capability names.
  "toJSON",
  "asymmetricMatch",
]);

/** The path proxy: a function-backed Proxy (not an RpcTarget instance) — each missing property
 *  extends `path`, and applying the function reduces the whole accumulated access into ONE
 *  `invoke(expression)` call, `[...root, ...path.slice(0, -1), [path.at(-1), ...args]]`. */
function createItxExpressionPathProxy(
  invoker: InvokeTarget,
  root: readonly string[],
  path: string[],
): unknown {
  const valueFor = (key: string) => createItxExpressionPathProxy(invoker, root, [...path, key]);
  return new Proxy(function () {}, {
    apply(_target, _thisArg, args) {
      const method = path[path.length - 1];
      const expr: ItxExpression = [...root, ...path.slice(0, -1), [method, ...(args as unknown[])]];
      return invoker.invoke(expr);
    },
    get(target, key, receiver) {
      if (typeof key === "symbol") return Reflect.get(target, key, receiver);
      if (RESERVED_SEGMENT_NAMES.has(key)) return undefined;
      return valueFor(key);
    },
    getOwnPropertyDescriptor(target, key) {
      const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
      if (descriptor) return descriptor;
      if (typeof key === "symbol" || RESERVED_SEGMENT_NAMES.has(key)) return undefined;
      // Cap'n Web's server-side path traversal probes own descriptors before reading a segment, so
      // dynamic roots must look discoverable here to reach the apply trap.
      return { configurable: true, enumerable: true, value: valueFor(key), writable: false };
    },
    has(target, key) {
      if (typeof key === "symbol") return key in target;
      return !RESERVED_SEGMENT_NAMES.has(key);
    },
  });
}

/** Install the hop drawn in the header on a class's PROTOTYPE CHAIN, with the scope `root` (`["itx"]`
 *  for the edge context, `[]` for a handle). Call ONCE per class. Constructor inheritance is
 *  untouched — only `Class.prototype`'s parent link changes, and the hop forwards everything it does
 *  not intercept. */
export function installPrototypeInvokeFallback<T extends abstract new (...args: never[]) => object>(
  cls: T,
  root: readonly string[],
): void {
  const parentPrototype = Object.getPrototypeOf(cls.prototype) as object;
  const hop = new Proxy(Object.create(parentPrototype) as object, {
    get(hopTarget, key, receiver) {
      // Symbols and anything the parent chain already answers (dispose protocol, capnweb
      // internals, Object.prototype) pass through with the instance as receiver.
      if (typeof key === "symbol" || key in hopTarget) {
        return Reflect.get(hopTarget, key, receiver);
      }
      if (RESERVED_SEGMENT_NAMES.has(key)) return undefined;
      // The dynamic fallback exists for INSTANCES. A lookup whose receiver is not one — someone
      // probing `Class.prototype.foo` directly, a framework walking prototypes — must see plain
      // "undefined", not conjure a dispatcher over an uninitialized receiver.
      if (!(receiver instanceof (cls as unknown as abstract new (...args: never[]) => object))) {
        return undefined;
      }
      // The receiver IS the invoker (it implements invoke). Its method resolves at CALL
      // time, so a trap firing mid-construction (a property miss on `this` before field initializers
      // ran) can't bake a dispatcher over half-initialized state into the path proxy.
      return createItxExpressionPathProxy(receiver as unknown as InvokeTarget, root, [key]);
    },
  });
  Object.setPrototypeOf(cls.prototype, hop);
}

/** A branded, pipelinable handle for a MID-CHAIN capability (`facets.get(name)`, `cd(path)`,
 *  `workers.get(spec)`, a lent stub) whose unknown dotted members reduce into ONE dispatch of the
 *  itx-expression STEPS relative to it; the constructor's `dispatch` routes those steps into the
 *  underlying object. Declared members (`invoke` / `applyRoot`) win over the fallback, so a
 *  capability cannot be named either — the two reserved words this wrapper adds. */
export class InvokeHandle extends RpcTarget {
  readonly #dispatchItxExpressionSteps: (itxExpressionSteps: ItxExpression) => unknown;
  constructor(dispatchItxExpressionSteps: (itxExpressionSteps: ItxExpression) => unknown) {
    super();
    this.#dispatchItxExpressionSteps = dispatchItxExpressionSteps;
  }
  /** THE dispatch method the prototype hop reduces onto; the expression is RELATIVE to this handle. */
  invoke(itxExpressionSteps: ItxExpression): unknown {
    return this.#dispatchItxExpressionSteps(itxExpressionSteps);
  }
  /** Call the bare capability this handle fronts — the ANONYMOUS call step (how a rewritten call
   *  whose target IS a handle calls it: `handle(events, range)`). */
  applyRoot(args: unknown[]): unknown {
    return this.#dispatchItxExpressionSteps([["", ...args]]);
  }
}
installPrototypeInvokeFallback(InvokeHandle, []);

/** Walk itx-expression steps off a capnweb stub; the ANONYMOUS call step (`""`) calls the value
 *  itself (a bare function lent as a capability). NO await inside the loop: on a capnweb stub every
 *  step is a PIPELINED path, so an n-step chain costs ONE round trip, flushed by the caller's single
 *  await. A DIRECT call on the stub, never `.apply`: reading `.apply` off a capnweb stub's method is
 *  itself a pipelined remote path, and calling it sends the stub as an argument, which a facet stub
 *  refuses with a DataCloneError. What a connector over a lent stub or a remote capnweb API walks. */
export function walkStepsOnRpcStub(stub: unknown, steps: ItxExpression): unknown {
  let value: unknown = stub;
  for (const step of steps) {
    if (typeof step === "string") value = (value as Record<string, unknown>)[step];
    else {
      const [method, ...args] = step;
      value =
        method === ""
          ? (value as (...a: unknown[]) => unknown)(...args)
          : (value as Record<string, (...a: unknown[]) => unknown>)[method](...args);
    }
  }
  return value;
}
