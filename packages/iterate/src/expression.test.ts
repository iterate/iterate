// expression.test.ts — executable spec for the expression codec (parse ⇄ print over one table,
// the canonical spelling, comments in args, the char limit) and the prototype hop's dotted invoke.
// What the platform does with an expression — the step walk, the resolver over it — is tested in
// apps/os src/context/dispatch.test.ts.

import { expect, test } from "vitest";
import { RpcStub, RpcTarget } from "capnweb";
import {
  normalizedItxExpression,
  parse,
  parseItxExpressionPrefix,
  print,
  type ItxExpression,
  installPrototypeInvokeFallback,
} from "./expression.ts";

// Plausible itx expressions in CANONICAL form — exactly what `print` emits (single-quoted strings,
// unquoted identifier keys, no spaces). Each row is checked BOTH directions.
const TABLE: [string, ItxExpression][] = [
  ["itx.kv", ["itx", "kv"]], // a getter path (no call)
  ["itx.whoami()", ["itx", ["whoami"]]], // a call with no args
  ["itx.kv.get('src/app.js')", ["itx", "kv", ["get", "src/app.js"]]],
  ["itx.kv.put('k','v')", ["itx", "kv", ["put", "k", "v"]]], // multiple args
  ["itx.facets.get('tally').snapshot()", ["itx", "facets", ["get", "tally"], ["snapshot"]]], // chain
  ["itx.robots.get('robot-arm-1').ping()", ["itx", "robots", ["get", "robot-arm-1"], ["ping"]]],
  [
    "itx.facets.get({className:'CounterDurableObject'})",
    ["itx", "facets", ["get", { className: "CounterDurableObject" }]],
  ],
  [
    // the CANONICAL spelling sorts object keys (one spelling per object ⇒ one rewrite-rule row)
    "itx.append({payload:{n:1,ok:true,tags:['a','b']},type:'evt'})",
    ["itx", ["append", { type: "evt", payload: { n: 1, ok: true, tags: ["a", "b"] } }]],
  ],
  ["itx.math.add(1,-2.5,true,null)", ["itx", "math", ["add", 1, -2.5, true, null]]], // primitives
];

test.each(TABLE)("expression codec, parse: %s", (str, expr) => {
  expect(parse(str)).toEqual(expr);
});
test.each(TABLE)("expression codec, print: %s", (str, expr) => {
  expect(print(expr)).toBe(str);
});

// parse → print collapses whitespace, quote style and OBJECT KEY ORDER to ONE spelling — a call and
// a rule's match alike. So two spellings of one pinned object are ONE rewrite-rule row (the table is
// a map by the printed match) and `rewriteRules.get` finds a row however the caller spells it.
const CANONICAL: { spelled: string; becomes: string }[] = [
  { spelled: "itx.ai.run({model:'x',fast:true})", becomes: "itx.ai.run({fast:true,model:'x'})" },
  { spelled: "itx.ai.run({fast:true,model:'x'})", becomes: "itx.ai.run({fast:true,model:'x'})" },
  { spelled: 'itx.ai.run( "x" , {b:1, a:2} )', becomes: "itx.ai.run('x',{a:2,b:1})" },
];
test.each(CANONICAL)("canonical spelling: $spelled prints as $becomes", ({ spelled, becomes }) => {
  expect(print(parse(spelled))).toBe(becomes);
  expect(print(parseItxExpressionPrefix(spelled))).toBe(becomes); // a rule's match, the same way
});

// A JSON5 comment inside call args is a comment — never a marker, never a quote: the one span the
// lexer and the paren walker skip is "a string literal OR a comment".
const COMMENTED: { spelled: string; parsesTo: ItxExpression }[] = [
  { spelled: "itx.x(/* @ */ 1)", parsesTo: ["itx", ["x", 1]] },
  { spelled: "itx.x(1 /* it's */, 2)", parsesTo: ["itx", ["x", 1, 2]] },
  { spelled: "itx.x(1, // a ')' here\n 2)", parsesTo: ["itx", ["x", 1, 2]] },
  {
    spelled: "itx.x('// not a comment', '/* nor this */')",
    parsesTo: ["itx", ["x", "// not a comment", "/* nor this */"]],
  },
];
test.each(COMMENTED)("comments inside call args: $spelled parses", ({ spelled, parsesTo }) => {
  expect(parse(spelled)).toEqual(parsesTo);
});

test("a string expression over the char limit is refused, coded, before any parsing; the parsed form carries the same thing", () => {
  const big = `itx.workers.get({ source: { "worker.js": ${JSON.stringify("x".repeat(3000))} } })`;
  expect(() => parse(big)).toThrowError(/EXPRESSION_TOO_LONG|over the 2048-char limit/);
  expect(
    normalizedItxExpression([
      "itx",
      "workers",
      ["get", { source: { "worker.js": "x".repeat(3000) } }],
    ]),
  ).toHaveLength(3);
});

// ── invoke handle ── the dotted invoke's pure mechanism (the prototype hop and the path proxies it
// hands out), in-process, driven over a real capnweb RpcStub. The end-to-end dotted surface over the
// real worker is pinned by apps/os's e2e tests.

test("keeps real RpcTarget members and falls back only for unknown paths", async () => {
  const target = new HostTarget();
  const stub = new RpcStub(target as never) as unknown as HostStub;

  await expect(stub.known("x")).resolves.toBe("known:x");
  await expect(stub.nested.math.add(20, 22)).resolves.toBe(42);
  await expect(stub.tools.greeter.sayHello("Ada")).resolves.toBe(
    "dynamic:tools.greeter.sayHello:Ada",
  );

  expect(target).toMatchObject({
    calls: [{ args: ["Ada"], path: ["tools", "greeter", "sayHello"] }],
  });
});

test("instances are genuine, unproxied RpcTargets (the whole point: workerd pipelining)", () => {
  // The fallback lives on the PROTOTYPE CHAIN, so the instance stays a plain, natively-branded
  // RpcTarget (no own dynamic props, no instance Proxy) — what workerd's pipeline classifier
  // requires. The live guard for pipelining itself is apps/os's e2e tests; this pins the
  // structural half a unit test can see.
  const target = new HostTarget();
  expect(target).toBeInstanceOf(RpcTarget);
  expect(Object.getOwnPropertyNames(target)).toEqual(["calls", "ownField"]);
});

test("dispatches through the invoker derived from the RECEIVING instance", () => {
  const a = new HostTarget();
  const b = new HostTarget();
  (a as unknown as { toolA(): unknown }).toolA();
  (b as unknown as { toolB(): unknown }).toolB();
  expect(a).toMatchObject({ calls: [{ args: [], path: ["toolA"] }] });
  expect(b).toMatchObject({ calls: [{ args: [], path: ["toolB"] }] });
});

test("awaiting an instance must not treat it as a thenable", async () => {
  const target = new HostTarget();
  expect((target as unknown as { then: unknown }).then).toBeUndefined();
  await expect(Promise.resolve(target)).resolves.toBe(target);
});

test("does not expose RpcTarget instance fields as dynamic paths", async () => {
  const stub = new RpcStub(new HostTarget() as never) as unknown as HostStub;
  await expect(stub.ownField()).rejects.toThrow(/instance property/);
});

test("lets __describe traverse dynamic paths over RPC (the host intercepts it)", async () => {
  const target = new HostTarget();
  const stub = new RpcStub(target as never) as unknown as {
    someMount: { sub: { __describe(): Promise<string> } };
  };
  await expect(stub.someMount.sub.__describe()).resolves.toBe("dynamic:someMount.sub.__describe:");
  expect(target).toMatchObject({ calls: [{ args: [], path: ["someMount", "sub", "__describe"] }] });
});

test("JSON.stringify and test-framework probes must not fire dispatches", () => {
  const target = new HostTarget();
  expect(JSON.stringify(target)).toBe(JSON.stringify({ calls: [], ownField: "private" }));
  expect((target as unknown as { toJSON: unknown }).toJSON).toBeUndefined();
  expect((target as unknown as { asymmetricMatch: unknown }).asymmetricMatch).toBeUndefined();
  expect(target).toMatchObject({ calls: [] });

  // `inspect` stays dispatchable at BOTH levels (mounted capabilities legitimately expose it).
  expect((target as unknown as { inspect(v: string): unknown }).inspect("surface")).toBe(
    "dynamic:inspect:surface",
  );
  const probe = target as unknown as { agentProbe: { inspect(v: string): unknown } };
  expect(probe.agentProbe.inspect("deep")).toBe("dynamic:agentProbe.inspect:deep");
  expect(target).toMatchObject({
    calls: [
      { args: ["surface"], path: ["inspect"] },
      { args: ["deep"], path: ["agentProbe", "inspect"] },
    ],
  });
});

test("probes are blocked at DEPTH too — stringify of a path proxy must not dispatch", () => {
  const target = new HostTarget();
  const mount = (target as unknown as Record<string, unknown>).someMount as Record<string, unknown>;
  expect(JSON.stringify({ mount })).toBe("{}");
  expect(mount.toJSON).toBeUndefined();
  expect(mount.asymmetricMatch).toBeUndefined();
  expect("asymmetricMatch" in (mount as object)).toBe(false);
  const deeper = (mount as { sub: Record<string, unknown> }).sub;
  expect(deeper.toJSON).toBeUndefined();
  expect(target).toMatchObject({ calls: [] });
});

test("resolves the invoker at CALL time, not lookup time (mid-construction safety)", () => {
  const recorded: DynamicCall[] = [];
  class LateHost extends RpcTarget {
    ready = false;
    constructor() {
      super();
      // Probe a dynamic member DURING construction (before `ready` is set): the trap must not
      // bake a dispatcher over half-initialized state — the receiver's invoke resolves
      // only when the path proxy is CALLED, by which point construction has finished.
      void (this as unknown as { probedDuringConstruction: unknown }).probedDuringConstruction;
      this.ready = true;
    }
    invoke(call: ItxExpression) {
      if (!this.ready) throw new Error("invoker resolved before construction finished");
      recorded.push(unpackRelative(call));
      return "late";
    }
  }
  installPrototypeInvokeFallback(LateHost, []);

  const instance = new LateHost();
  const early = (instance as unknown as { earlyTool(): unknown }).earlyTool;
  expect(early()).toBe("late");
  expect(recorded).toEqual([{ args: [], path: ["earlyTool"] }]);
});

test("does not conjure dispatchers for non-instance receivers (prototype probes)", () => {
  const probed = (HostTarget.prototype as unknown as { someTool: unknown }).someTool;
  expect(probed).toBeUndefined();
});

test("subclass instances inherit the fallback and dispatch to themselves", () => {
  class Sub extends HostTarget {
    subKnown() {
      return "sub";
    }
  }
  const sub = new Sub();
  expect(sub.subKnown()).toBe("sub");
  expect(sub.known("y")).toBe("known:y");
  (sub as unknown as { subTool(v: string): unknown }).subTool("z");
  expect(sub).toMatchObject({ calls: [{ args: ["z"], path: ["subTool"] }] });
});

test("hides reserved path segments from the path proxies the hop hands out, at every depth", () => {
  const target = new HostTarget();
  const proxy = target as unknown as { alpha: { then: unknown; beta: { then: unknown } } };
  expect(proxy.alpha.then).toBeUndefined();
  expect(proxy.alpha.beta.then).toBeUndefined();
  expect(target).toMatchObject({ calls: [] });
});

// ── helpers ──

type DynamicCall = { args: unknown[]; path: string[] };

// The fallback reduces dotted access into ONE relative `ItxExpression` (root `[]`, always the array
// form): property-read steps then a final call step. Unpack it back to `{ path, args }` so these
// tests can keep asserting on the accumulated path — the mechanism under test is the accumulation,
// not the wire shape.
function unpackRelative(expr: ItxExpression): DynamicCall {
  const tail = expr.at(-1);
  if (!tail) return { path: [], args: [] };
  const [method, args] =
    typeof tail === "string" ? [tail, [] as unknown[]] : [tail[0], tail.slice(1)];
  return { path: [...(expr.slice(0, -1) as string[]), method], args };
}

class HostTarget extends RpcTarget {
  calls: DynamicCall[] = [];
  ownField = "private";

  get nested() {
    return {
      math: {
        add(left: number, right: number) {
          return left + right;
        },
      },
    };
  }

  known(value: string) {
    return `known:${value}`;
  }

  invoke(call: ItxExpression) {
    const c = unpackRelative(call);
    this.calls.push(c);
    return `dynamic:${c.path.join(".")}:${c.args.join(",")}`;
  }
}
installPrototypeInvokeFallback(HostTarget, []);

type HostStub = {
  known(value: string): Promise<string>;
  nested: { math: { add(left: number, right: number): Promise<number> } };
  ownField(): Promise<unknown>;
  tools: { greeter: { sayHello(name: string): Promise<string> } };
};
