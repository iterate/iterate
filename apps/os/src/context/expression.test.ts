import {
  InvokeHandle,
  RpcStubHandle,
  ITX_HANDLE_REFERENCE_KEY,
  itxAnswerDetachedFromSession,
  materializeItxHandleReference,
} from "iterate/next/expression";
// Executable spec for the expression codec — two directions over one table.
import { describe, expect, test, it, vi } from "vitest";
import { RpcStub, RpcTarget } from "capnweb";
import {
  normalizedItxExpression,
  parse,
  parseItxExpressionPrefix,
  print,
  type ItxExpression,
  registerPipelinedRpcBrand,
  registerRpcSessionBrand,
  releaseRpcSessions,
  walkSteps,
  installPrototypeInvokeFallback,
} from "iterate/next/expression";
import type { ItxExpressionRewriteRule } from "./itx-expression-rewriting.ts";
import { BUILT_IN_ROOTS, ItxExpressionResolver } from "./itx-expression-rewriting.ts";
import { ScopedArtifactRepoRpcTarget, type ArtifactsNamespace } from "./repos.ts";

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

describe("expression codec", () => {
  test.each(TABLE)("parse: %s", (str, expr) => {
    expect(parse(str)).toEqual(expr);
  });
  test.each(TABLE)("print: %s", (str, expr) => {
    expect(print(expr)).toBe(str);
  });
});

// parse → print collapses whitespace, quote style and OBJECT KEY ORDER to ONE spelling — a call and
// a rule's match alike. So two spellings of one pinned object are ONE rewrite-rule row (the table is
// a map by the printed match) and `rewriteRules.get` finds a row however the caller spells it.
const CANONICAL: { spelled: string; becomes: string }[] = [
  { spelled: "itx.ai.run({model:'x',fast:true})", becomes: "itx.ai.run({fast:true,model:'x'})" },
  { spelled: "itx.ai.run({fast:true,model:'x'})", becomes: "itx.ai.run({fast:true,model:'x'})" },
  { spelled: 'itx.ai.run( "x" , {b:1, a:2} )', becomes: "itx.ai.run('x',{a:2,b:1})" },
];
describe("canonical spelling: parse → print", () => {
  test.each(CANONICAL)("$spelled prints as $becomes", ({ spelled, becomes }) => {
    expect(print(parse(spelled))).toBe(becomes);
    expect(print(parseItxExpressionPrefix(spelled))).toBe(becomes); // a rule's match, the same way
  });
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
describe("comments inside call args", () => {
  test.each(COMMENTED)("$spelled parses", ({ spelled, parsesTo }) => {
    expect(parse(spelled)).toEqual(parsesTo);
  });
});

test("a string expression over the char limit is refused, coded, before any parsing; the parsed form carries the same thing", () => {
  const big = `itx.workers.get({ source: { "cap.js": ${JSON.stringify("x".repeat(3000))} } })`;
  expect(() => parse(big)).toThrowError(/EXPRESSION_TOO_LONG|over the 2048-char limit/);
  expect(
    normalizedItxExpression([
      "itx",
      "workers",
      ["get", { source: { "cap.js": "x".repeat(3000) } }],
    ]),
  ).toHaveLength(3);
});

// ── dispatch ── executable spec for the step walk (and the resolver over a fake built-ins scope, where a walk is
// only observable through a rewrite rule). Rule MATCHING is itx-expression-rewriting.test.ts — the
// table.

// ───────────────────────────── the step walk + a rewrite rule, end to end ─────────────────────────────

/** A fake built-ins scope: enough physical layer to walk into — under REAL root names, since the
 *  resolver's platform rows come from the leaf list (itx-expression-rewriting.ts `BUILT_IN_ROOTS`). `kv` is `this`-dependent on purpose
 *  (a method detached from its receiver would lose its store). */
const scope = () => {
  const log: string[] = [];
  return {
    log,
    builtIns: {
      kv: {
        store: new Map<string, string>(),
        get(k: string) {
          return this.store.get(k);
        },
        put(k: string, v: string) {
          this.store.set(k, v);
          return { ok: true };
        },
      },
      ai: {
        chat: (o: { model: string; messages?: unknown[] }) => `chat(${o.model})`,
      },
      workers: {
        get: (key: string) => ({
          ping: () => `pong:${key}`,
          arm: {
            move: (n: number) => {
              log.push(`move ${n} @${key}`);
              return "moved";
            },
          },
        }),
      },
      // a stub-returning chain — pipelining through an async hop
      facets: {
        get: async (_ref: unknown) => ({ counters: { add: async (n: number) => 40 + n } }),
      },
      append: (e: unknown) => {
        log.push(`append ${JSON.stringify(e)}`);
        return { offset: 1 };
      },
    },
  };
};
const rewriteRule = (match: string, target: string): ItxExpressionRewriteRule => ({
  match: parseItxExpressionPrefix(match),
  target: parse(target),
});
const resolverOver = (s: ReturnType<typeof scope>, ...rewriteRules: ItxExpressionRewriteRule[]) =>
  new ItxExpressionResolver({
    builtIns: s.builtIns,
    rewriteRules: () => rewriteRules,
    implicitRoots: new Set(BUILT_IN_ROOTS),
    path: "/",
    caller: () => ({ principal: null }),
  });

describe("walkSteps + resolve", () => {
  test("pipelined chain: call → await stub → call again", async () => {
    const s = scope();
    const { value } = await walkSteps(
      { value: s.builtIns, receiver: undefined },
      parse("itx.facets.get({ className: 'CounterDurableObject' }).counters.add(2)").slice(1),
    );
    expect(value).toBe(42);
  });

  test("a rule targeting a call, end to end — the steps after the match replay on the value", async () => {
    const s = scope();
    const resolver = resolverOver(s, rewriteRule("itx.robot", "itx.workers.get('robot-arm-1')"));
    expect(await resolver.invoke("itx.robot.arm.move(10)")).toBe("moved");
    expect(s.log).toEqual(["move 10 @robot-arm-1"]);
  });

  test("args at the match apply the rewritten target as a call", async () => {
    const s = scope();
    const resolver = resolverOver(s, rewriteRule("itx.grok", "itx.ai.chat"));
    expect(await resolver.invoke("itx.grok({ model: 'grok-4', messages: ['hi'] })")).toBe(
      "chat(grok-4)",
    );
  });

  test("args at the match on a non-callable target error LOUDLY (no silent drop)", async () => {
    const s = scope();
    const resolver = resolverOver(s, rewriteRule("itx.db", "itx.kv"));
    await expect(resolver.invoke("itx.db('oops')")).rejects.toThrow(/not a method|not callable/);
    // CODED, like the dotted sibling (NOT_A_METHOD): the delivery loop treats it as deterministic
    // and halts an uncallable cursor target at the first failure instead of climbing the ladder.
    await expect(resolver.invoke("itx.db('oops')")).rejects.toMatchObject({ code: "NOT_A_METHOD" });
  });

  test("args at the match on a method-valued target apply on the carried receiver", async () => {
    const s = scope();
    const resolver = resolverOver(s, rewriteRule("itx.remember", "itx.kv.put"));
    expect(await resolver.invoke("itx.remember('k', 'v')")).toEqual({ ok: true });
    expect(await resolver.invoke("itx.kv.get('k')")).toBe("v"); // `this` was kv, not the rule
  });

  test("`__proto__` / `constructor` / `prototype` never resolve as steps (hand-built — the codec refuses to parse them)", async () => {
    const kv = { get: (k: string) => `v:${k}` };
    const walk = (steps: ItxExpression) => walkSteps({ value: kv, receiver: undefined }, steps);
    await expect(walk(["constructor", "name"])).rejects.toThrow(/hit undefined/);
    await expect(walk(["__proto__", "x"])).rejects.toThrow(/hit undefined/);
  });

  test("calling the bare scope symbol is a loud error (the parser guards it)", () => {
    // The dotted write-half is `InvokeHandle`; the "can't call the scope root itself" guard lives in
    // the codec parser (a bare `itx(...)` never becomes a legal expression).
    expect(() => parse("itx(1)")).toThrow(/cannot call the scope symbol itself/);
  });
});

// ───────────────────────────── pipelined RPC promise threading ─────────────────────────────
// THE CONTRACT (walkSteps): a value carrying a registered pipelinable-promise brand is NEVER
// awaited mid-chain — property access and calls build on it directly, and only the caller's
// terminal await settles the chain. Everything else (plain thenables included) keeps the
// await-every-step behavior. For native workerd RPC (worker.ts registers the cloudflare:workers
// RpcPromise/RpcProperty at boot) this collapses a facet or loaded-entrypoint chain into one
// pipelined round trip; the brand list is EMPTY in this Node lane, so the test registers its own.

describe("pipelined RPC promise threading", () => {
  /** A thenable that records every await and chains svc/add like a remote API — the test brand. */
  class FakeRpcPromise {
    static awaited: string[] = [];
    constructor(readonly chain: string) {}
    then(resolve: (v: unknown) => void): void {
      FakeRpcPromise.awaited.push(this.chain);
      resolve({ settled: this.chain });
    }
    svc(name: string): FakeRpcPromise {
      return new FakeRpcPromise(`${this.chain}.svc(${name})`);
    }
    add(a: number, b: number): FakeRpcPromise {
      return new FakeRpcPromise(`${this.chain}.add(${a},${b})`);
    }
  }
  registerPipelinedRpcBrand(FakeRpcPromise);
  /** A stub an awaited call answered with (a facet's collection): not a promise, but it holds its
   *  session until disposed — as iterate-context.ts registers the native RpcStub. */
  class FakeRpcStub {
    constructor(readonly chain: string) {}
    list(): unknown {
      return new FakeRpcPromise(`${this.chain}.list()`);
    }
  }
  registerRpcSessionBrand(FakeRpcPromise);
  registerRpcSessionBrand(FakeRpcStub);

  test("a registered brand threads UNAWAITED through call-then-call — the terminal settles once", async () => {
    FakeRpcPromise.awaited = [];
    const itx = { dial: () => new FakeRpcPromise("dial") };
    const { value } = await walkSteps(
      { value: itx, receiver: undefined },
      parse("itx.dial().svc('x').add(2, 3)").slice(1),
    );
    // no step awaited any intermediate — the chain BUILT on the promises
    expect(FakeRpcPromise.awaited).toEqual([]);
    expect(value).toBeInstanceOf(FakeRpcPromise);
    expect((value as FakeRpcPromise).chain).toBe("dial.svc(x).add(2,3)");
    // the caller's terminal await is the single settle (what resolve() does at its end)
    expect(await value).toEqual({ settled: "dial.svc(x).add(2,3)" });
    expect(FakeRpcPromise.awaited).toEqual(["dial.svc(x).add(2,3)"]);
  });

  test("rpcSessionsSteppedPast collects every session-holding value stepped past, pipelined or awaited — never the start, never the answer", async () => {
    // The resolver's `invoke` and facet-host.ts `#call` release these once the answer is in: each held
    // its session, and the actor at its far end, open until GC — the collection stub a facet answered
    // `repos()` with, walked on for `.create(path)`, kept a project's root resident (2026-09-23).
    const itx = {
      dial: () => new FakeRpcPromise("dial"),
      collection: async () => new FakeRpcStub("collection"), // awaited: a facet call's answer
      local: { twice: (n: number) => n * 2 }, // holds no session
    };
    const walk = async (source: string) => {
      const rpcSessionsSteppedPast: unknown[] = [];
      const { value } = await walkSteps(
        { value: itx, receiver: undefined },
        parse(source).slice(1),
        rpcSessionsSteppedPast,
      );
      return { value, steppedPast: rpcSessionsSteppedPast.map((s) => (s as FakeRpcStub).chain) };
    };
    expect(await walk("itx.dial().svc('x').add(2, 3)")).toMatchObject({
      steppedPast: ["dial", "dial.svc(x)"],
      value: { chain: "dial.svc(x).add(2,3)" },
    });
    expect(await walk("itx.collection().list()")).toMatchObject({
      steppedPast: ["collection"],
      value: { chain: "collection.list()" },
    });
    expect(await walk("itx.local.twice(2)")).toEqual({ steppedPast: [], value: 4 });
  });

  test("the resolver releases what its walk stepped past once the answer is in; the answer stays the caller's", async () => {
    const order: string[] = [];
    // the project facet's collection, as `facets.get('project').repos()` answers it: awaited, a stub
    const collection = Object.assign(new FakeRpcStub("repos"), {
      list: () => ({
        then(resolve: (paths: string[]) => void) {
          order.push("answer settled");
          resolve(["/repos/a"]);
        },
      }),
      [Symbol.dispose]: () => order.push("collection released"),
    });
    const resolver = new ItxExpressionResolver({
      builtIns: { facets: { get: () => ({ repos: async () => collection }) } },
      rewriteRules: () => [],
      implicitRoots: new Set(BUILT_IN_ROOTS),
      path: "/",
      caller: () => ({ principal: null }),
    });
    expect(await resolver.invoke("itx.facets.get('project').repos().list()")).toEqual(["/repos/a"]);
    expect(order).toEqual(["answer settled", "collection released"]);
  });

  test("the resolver releases a walk's answer that REJECTS — its caller gets the rejection, never the promise — and never one that arrives", async () => {
    // A Workers-RPC call that threw keeps its callee's session open until its promise is disposed:
    // the project facet's collection refusing `delete` held the project's root resident (2026-09-23).
    const released: string[] = [];
    class FakeCallPromise {
      constructor(
        readonly chain: string,
        readonly outcome: { error: Error } | { value: unknown },
      ) {}
      then(resolve: (value: unknown) => void, reject: (error: unknown) => void): void {
        if ("error" in this.outcome) reject(this.outcome.error);
        else resolve(this.outcome.value);
      }
      [Symbol.dispose](): void {
        released.push(this.chain);
      }
    }
    registerPipelinedRpcBrand(FakeCallPromise);
    registerRpcSessionBrand(FakeCallPromise);
    const collection = {
      delete: (path: string) =>
        new FakeCallPromise(`delete(${path})`, { error: new Error(`${path}: not created`) }),
      list: () => new FakeCallPromise("list()", { value: ["/w"] }),
    };
    const resolver = new ItxExpressionResolver({
      builtIns: { facets: { get: () => ({ workspaces: async () => collection }) } },
      rewriteRules: () => [],
      implicitRoots: new Set(BUILT_IN_ROOTS),
      path: "/",
      caller: () => ({ principal: null }),
    });
    await expect(
      resolver.invoke("itx.facets.get('project').workspaces().delete('/never')"),
    ).rejects.toThrow("/never: not created");
    expect(released).toEqual(["delete(/never)"]);
    expect(await resolver.invoke("itx.facets.get('project').workspaces().list()")).toEqual(["/w"]);
    expect(released).toEqual(["delete(/never)"]); // the answer that arrived is the caller's
  });

  test("releaseRpcSessions releases each once, the last first; one that throws is reported, the rest still released", () => {
    const released: string[] = [];
    const session = (name: string, fail = false) => ({
      [Symbol.dispose]() {
        released.push(name);
        if (fail) throw new Error(`${name} already gone`);
      },
    });
    const reported = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      expect(() =>
        releaseRpcSessions([session("first"), session("middle", true), session("last")]),
      ).not.toThrow();
      expect(released).toEqual(["last", "middle", "first"]);
      expect(reported).toHaveBeenCalled();
    } finally {
      reported.mockRestore();
    }
  });

  test("an UNREGISTERED thenable keeps the default: awaited at every step", async () => {
    const awaited: string[] = [];
    const plain = (chain: string) => ({
      then(resolve: (v: unknown) => void) {
        awaited.push(chain);
        resolve({ svc: (name: string) => plain(`${chain}.svc(${name})`) });
      },
    });
    const itx = { dial: () => plain("dial") };
    const { value } = await walkSteps(
      { value: itx, receiver: undefined },
      parse("itx.dial().svc('x')").slice(1),
    );
    // the walk awaited the intermediate before stepping into it, and settled the tail too
    expect(awaited).toEqual(["dial", "dial.svc(x)"]);
    expect(value).toEqual({ svc: expect.any(Function) });
  });
});

// ── invoke handle ── the dotted door's pure mechanism (the prototype hop and the path
// proxies it hands out), in-process (unit lane), driven over a real capnweb RpcStub. PORTED (not
// verbatim) from apps/os/src/domains/itx/path-proxy.test.ts. The end-to-end dotted surface over the
// real worker is pinned in the e2e lane.

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

describe("prototype-chain dynamic fallback", () => {
  it("keeps real RpcTarget members and falls back only for unknown paths", async () => {
    const target = new HostTarget();
    const stub = new RpcStub(target as never) as unknown as HostStub;

    await expect(stub.known("x")).resolves.toBe("known:x");
    await expect(stub.nested.math.add(20, 22)).resolves.toBe(42);
    await expect(stub.tools.greeter.sayHello("Ada")).resolves.toBe(
      "dynamic:tools.greeter.sayHello:Ada",
    );

    expect(target.calls).toEqual([{ args: ["Ada"], path: ["tools", "greeter", "sayHello"] }]);
  });

  it("instances are genuine, unproxied RpcTargets (the whole point: workerd pipelining)", () => {
    // The fallback lives on the PROTOTYPE CHAIN, so the instance stays a plain, natively-branded
    // RpcTarget (no own dynamic props, no instance Proxy) — what workerd's pipeline classifier
    // requires. The live guard for pipelining itself is the e2e lane; this pins the structural
    // half the unit lane can see.
    const target = new HostTarget();
    expect(target).toBeInstanceOf(RpcTarget);
    expect(Object.getOwnPropertyNames(target)).toEqual(["calls", "ownField"]);
  });

  it("dispatches through the invoker derived from the RECEIVING instance", () => {
    const a = new HostTarget();
    const b = new HostTarget();
    (a as unknown as { toolA(): unknown }).toolA();
    (b as unknown as { toolB(): unknown }).toolB();
    expect(a.calls).toEqual([{ args: [], path: ["toolA"] }]);
    expect(b.calls).toEqual([{ args: [], path: ["toolB"] }]);
  });

  it("awaiting an instance must not treat it as a thenable", async () => {
    const target = new HostTarget();
    expect((target as unknown as { then: unknown }).then).toBeUndefined();
    await expect(Promise.resolve(target)).resolves.toBe(target);
  });

  it("does not expose RpcTarget instance fields as dynamic paths", async () => {
    const stub = new RpcStub(new HostTarget() as never) as unknown as HostStub;
    await expect(stub.ownField()).rejects.toThrow(/instance property/);
  });

  it("lets __describe traverse dynamic paths over RPC (the host intercepts it)", async () => {
    const target = new HostTarget();
    const stub = new RpcStub(target as never) as unknown as {
      someMount: { sub: { __describe(): Promise<string> } };
    };
    await expect(stub.someMount.sub.__describe()).resolves.toBe(
      "dynamic:someMount.sub.__describe:",
    );
    expect(target.calls).toEqual([{ args: [], path: ["someMount", "sub", "__describe"] }]);
  });

  it("JSON.stringify and test-framework probes must not fire dispatches", () => {
    const target = new HostTarget();
    expect(JSON.stringify(target)).toBe(JSON.stringify({ calls: [], ownField: "private" }));
    expect((target as unknown as { toJSON: unknown }).toJSON).toBeUndefined();
    expect((target as unknown as { asymmetricMatch: unknown }).asymmetricMatch).toBeUndefined();
    expect(target.calls).toEqual([]);

    // `inspect` stays dispatchable at BOTH levels (mounted capabilities legitimately expose it).
    expect((target as unknown as { inspect(v: string): unknown }).inspect("surface")).toBe(
      "dynamic:inspect:surface",
    );
    const probe = target as unknown as { agentProbe: { inspect(v: string): unknown } };
    expect(probe.agentProbe.inspect("deep")).toBe("dynamic:agentProbe.inspect:deep");
    expect(target.calls).toEqual([
      { args: ["surface"], path: ["inspect"] },
      { args: ["deep"], path: ["agentProbe", "inspect"] },
    ]);
  });

  it("probes are blocked at DEPTH too — stringify of a path proxy must not dispatch", () => {
    const target = new HostTarget();
    const mount = (target as unknown as Record<string, unknown>).someMount as Record<
      string,
      unknown
    >;
    expect(JSON.stringify({ mount })).toBe("{}");
    expect(mount.toJSON).toBeUndefined();
    expect(mount.asymmetricMatch).toBeUndefined();
    expect("asymmetricMatch" in (mount as object)).toBe(false);
    const deeper = (mount as { sub: Record<string, unknown> }).sub;
    expect(deeper.toJSON).toBeUndefined();
    expect(target.calls).toEqual([]);
  });

  it("resolves the invoker at CALL time, not lookup time (mid-construction safety)", () => {
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

  it("does not conjure dispatchers for non-instance receivers (prototype probes)", () => {
    const probed = (HostTarget.prototype as unknown as { someTool: unknown }).someTool;
    expect(probed).toBeUndefined();
  });

  it("subclass instances inherit the fallback and dispatch to themselves", () => {
    class Sub extends HostTarget {
      subKnown() {
        return "sub";
      }
    }
    const sub = new Sub();
    expect(sub.subKnown()).toBe("sub");
    expect(sub.known("y")).toBe("known:y");
    (sub as unknown as { subTool(v: string): unknown }).subTool("z");
    expect(sub.calls).toEqual([{ args: ["z"], path: ["subTool"] }]);
  });

  it("hides reserved path segments from the path proxies the hop hands out, at every depth", () => {
    const target = new HostTarget();
    const proxy = target as unknown as { alpha: { then: unknown; beta: { then: unknown } } };
    expect(proxy.alpha.then).toBeUndefined();
    expect(proxy.alpha.beta.then).toBeUndefined();
    expect(target.calls).toEqual([]);
  });
});

// ── an answer leaves a context holding nothing of its session ── what the context's RPC `invoke`
// hands back (expression.ts `itxAnswerDetachedFromSession`): the table the careless-caller rows of
// e2e/context-residency.e2e.test.ts prove on the deployed worker.
describe("an answer leaves a context holding nothing of its session", () => {
  /** A Workers-RPC stub a hop below answered with — registered as iterate-context.ts registers the
   *  native RpcStub — counting its releases. */
  class FakeHopRpcStub {
    released = 0;
    [Symbol.dispose](): void {
      this.released++;
    }
  }
  registerRpcSessionBrand(FakeHopRpcStub);
  /** What workerd hands a caller for a hop's answer: the data, plus a non-enumerable disposer that
   *  releases what the hop left open. */
  const answeredByHop = <T extends object>(data: T): { answer: T; released: () => number } => {
    let released = 0;
    Object.defineProperty(data, Symbol.dispose, { value: () => released++, enumerable: false });
    return { answer: data, released: () => released };
  };
  class BuiltHereRpcTarget extends RpcTarget {
    hello(): string {
      return "hello";
    }
  }
  const repoHandleExpression: ItxExpression = ["itx", "repos", ["get", "/repos/x"]];

  test.each<[string, unknown, ItxExpression, unknown[], ItxExpression]>([
    [
      "a path-shaped handle",
      new InvokeHandle(() => undefined),
      repoHandleExpression,
      [],
      repoHandleExpression,
    ],
    [
      "a lent stub's handle: it dispatches by its key, so its expression reaches the same stub",
      new RpcStubHandle(() => undefined),
      ["itx", "rpcStubs", ["get", "k"]],
      [],
      ["itx", "rpcStubs", ["get", "k"]],
    ],
    [
      "an RpcTarget built here (a library connection)",
      new BuiltHereRpcTarget(),
      ["itx", ["connectToMcp", "https://mcp.example"]],
      [],
      ["itx", ["connectToMcp", "https://mcp.example"]],
    ],
    [
      // prd 2026-09-23: a root session held one for 24 min, `remote`/`createToken` called on it live
      "the scoped Artifacts repo `cfArtifacts.get(path)` answers",
      new ScopedArtifactRepoRpcTarget({} as ArtifactsNamespace, "repos--x", "https://git/x.git"),
      ["itx", "cfArtifacts", ["get", "/repos/x"]],
      [],
      ["itx", "cfArtifacts", ["get", "/repos/x"]],
    ],
    ["a function", () => "called", ["itx", "kv", "get"], [], ["itx", "kv", "get"]],
    [
      "a Workers-RPC stub a hop below answered with (a loaded worker's RpcTarget)",
      new FakeHopRpcStub(),
      ["itx", "workers", ["get", { source: {} }], ["make"]],
      [],
      ["itx", "workers", ["get", { source: {} }], ["make"]],
    ],
    [
      "a reference from a hop below, re-rooted to this caller's call",
      { [ITX_HANDLE_REFERENCE_KEY]: repoHandleExpression },
      ["itx", ["cd", "/b"], "repos", ["get", "/repos/x"]],
      [],
      ["itx", ["cd", "/b"], "repos", ["get", "/repos/x"]],
    ],
    [
      "runtime args fold into a terminal name, as the resolver folds them",
      new InvokeHandle(() => undefined),
      ["itx", "repos", "get"],
      ["/repos/x"],
      repoHandleExpression,
    ],
    [
      "runtime args left over are the anonymous call on the value, as the resolver applies them",
      new InvokeHandle(() => undefined),
      repoHandleExpression,
      ["extra"],
      [...repoHandleExpression, ["", "extra"]],
    ],
  ])("live, named by its expression: %s", (_, result, expression, args, expected) => {
    expect(itxAnswerDetachedFromSession(result, expression, args)).toEqual({
      [ITX_HANDLE_REFERENCE_KEY]: expected,
    });
  });

  test("a stub a hop below answered with is released once as it is named", () => {
    const stub = new FakeHopRpcStub();
    itxAnswerDetachedFromSession(stub, ["itx", "workers", ["get", {}], ["make"]]);
    expect(stub.released).toBe(1);
  });

  test("data a hop below answered with leaves as a copy with no disposer; the original is released", () => {
    const { answer, released } = answeredByHop({ a: 1, nested: { b: [2] } });
    const copy = itxAnswerDetachedFromSession(answer, ["itx", "workers", ["get", {}], ["data"]]);
    expect(copy).not.toBe(answer);
    expect(copy).toEqual({ a: 1, nested: { b: [2] } });
    expect(Symbol.dispose in (copy as object)).toBe(false);
    expect(released()).toBe(1);
  });

  test("data built here and primitives cross as they are, uncopied", () => {
    const page = { events: [{ offset: 1 }], scannedThroughOffset: 1 };
    expect(itxAnswerDetachedFromSession(page, ["itx", ["readEvents"]])).toBe(page);
    expect(itxAnswerDetachedFromSession(7, ["itx", "kv", ["get", "k"]])).toBe(7);
    expect(itxAnswerDetachedFromSession(null, ["itx", "kv", ["get", "k"]])).toBe(null);
  });

  test("what can neither be copied nor named — a stream, data holding a function — crosses as it is, unreleased", () => {
    const stream = answeredByHop(new ReadableStream());
    expect(
      itxAnswerDetachedFromSession(stream.answer, ["itx", "files", ["get", "a"], ["stream"]]),
    ).toBe(stream.answer);
    expect(stream.released()).toBe(0);
    const holdingAFunction = answeredByHop({ callback: () => "live" });
    expect(itxAnswerDetachedFromSession(holdingAFunction.answer, ["itx", ["x"]])).toBe(
      holdingAFunction.answer,
    );
    expect(holdingAFunction.released()).toBe(0);
  });

  test("the holder mints its own handle: a dotted call is the reference plus the steps, a whole call is itself", async () => {
    const calls: unknown[] = [];
    const materialized = materializeItxHandleReference(
      { [ITX_HANDLE_REFERENCE_KEY]: ["itx", "repos", ["get", "/repos/x"]] },
      (expression) => {
        calls.push(expression);
        return "answered";
      },
    ) as any;
    expect(materialized).toBeInstanceOf(InvokeHandle);
    expect(await materialized.readFile("worker.ts")).toBe("answered");
    expect(await materialized.invoke("itx.whoami()")).toBe("answered");
    expect(calls).toEqual([
      ["itx", "repos", ["get", "/repos/x"], ["readFile", "worker.ts"]],
      ["itx", ["whoami"]],
    ]);
    expect(materializeItxHandleReference({ ok: true }, () => undefined)).toEqual({ ok: true });
  });
});
