// core/itx-expression.ts — the itx-expression codec (target-core §4.2). A capability call, as DATA: a walk of
// steps from the itx root. A bare string is a property read; a `[method, ...args]` tuple is a call. It stores
// the NAME of a capability, never captured authority — authority comes from the root you evaluate against (so
// deleting a stored expression IS revocation). Mirrors apps/os `ItxExpression`. Two directions, a codec:
//   • encode: `captureExpression()` — drive a proxy (`c.root.files.read("/x")`), read back `c.steps()`.
//   • decode: `evaluateItxExpression(root, steps)` — walk the data with `Reflect.get` / `Reflect.apply`.
// Narrow ON PURPOSE (a codec, not a language): property reads + calls only, args are plain JSON. Multi-hop
// pipelining (a call returning a stub you call again) is deferred — v1 expressions are one terminal call.

/** One step relative to the itx root: a property read (string) or a call (`[method, ...args]`). */
export type ItxStep = string | [method: string, ...args: unknown[]];
export type ItxExpression = ItxStep[];

/** encode: a recording proxy. `const c = captureExpression(); c.root.files.read("/x"); c.steps()` →
 *  `["files", ["read", "/x"]]`. (Userspace ergonomics; not on the runtime path yet.) */
export function captureExpression(): { root: unknown; steps(): ItxExpression } {
  const steps: ItxStep[] = [];
  const build = (): unknown =>
    new Proxy(function () {}, {
      get(_t, p) {
        if (p === "then" || typeof p === "symbol") return undefined;
        steps.push(p as string);
        return build();
      },
      apply(_t, _this, args) {
        steps.push([steps.pop() as string, ...(args as unknown[])]); // the just-read property was a call
        return build();
      },
    });
  return { root: build(), steps: () => steps };
}

/** A root whose dotted access compiles to `invoke("itx.a.b", args)` — the host-side twin of the injected
 *  `itx.js` surface. Evaluate an expression against this to run it through a capability host. */
export function itxRoot(invoke: (callPath: string, args: unknown[]) => unknown): unknown {
  const build = (parts: string[]): unknown =>
    new Proxy(function () {}, {
      get: (_t, p) =>
        p === "then" || typeof p === "symbol" ? undefined : build([...parts, p as string]),
      apply: (_t, _this, args) => invoke(parts.join("."), args as unknown[]),
    });
  return build(["itx"]);
}

/** Reduce an expression to a flat `itx.a.b` callPath for ADDRESSING (string steps + call method names, joined).
 *  Used to route a fetch to a fetch-shaped capability by a serialized expression carried in an HTTP header —
 *  addressing names a MOUNT, so any call args in the expression don't participate. */
export function expressionCallPath(expr: ItxExpression): string {
  return "itx." + expr.map((s) => (typeof s === "string" ? s : s[0])).join(".");
}

/** decode: walk `expr` against `root`. A string step is a property read; a tuple step is an (awaited) call. Each
 *  step's result becomes the next receiver (so a future stub-returning call can pipeline). */
export async function evaluateItxExpression(root: unknown, expr: ItxExpression): Promise<unknown> {
  let recv: unknown = root;
  for (const step of expr) {
    if (typeof step === "string") {
      recv = Reflect.get(recv as object, step);
    } else {
      const [method, ...args] = step;
      const fn = Reflect.get(recv as object, method) as (...a: unknown[]) => unknown;
      recv = await Reflect.apply(fn, recv, args);
    }
  }
  return recv;
}
