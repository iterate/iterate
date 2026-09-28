// context/dispatch.test.ts — executable spec for dispatch.ts: the walk's pipelining contract, the
// step walk under a rewrite rule through `ItxExpressionResolver` over a fake built-ins scope, the
// resolver releasing what its walk held, and what a context's `invoke` answer leaves of a session.
// The codec and the prototype hop are the SDK's (packages/iterate src/expression.test.ts); rule
// MATCHING is itx-expression-rewriting.test.ts.

import { expect, test } from "vitest";
import { RpcTarget } from "capnweb";
import {
  InvokeHandle,
  parse,
  parseItxExpressionPrefix,
  type ItxExpression,
} from "iterate/expression";
import {
  RpcStubHandle,
  ITX_HANDLE_REFERENCE_KEY,
  itxAnswerDetachedFromSession,
  materializeItxHandleReference,
  registerPipelinedRpcBrand,
  registerRpcSessionBrand,
  walkSteps,
} from "./dispatch.ts";
import {
  BUILT_IN_ROOTS,
  ItxExpressionResolver,
  type ItxExpressionRewriteRule,
} from "./itx-expression-rewriting.ts";
import { ScopedArtifactRepoRpcTarget, type ArtifactsNamespace } from "./cf-artifacts.ts";

// ───────────────────────────── pipelined RPC promise threading ─────────────────────────────
// THE CONTRACT (walkSteps): a value carrying a registered pipelinable-promise brand is NEVER
// awaited mid-chain — property access and calls build on it directly, and only the caller's
// terminal await settles the chain. Everything else (plain thenables included) keeps the
// await-every-step behavior. For native workerd RPC (iterate-context.ts registers the cloudflare:workers
// RpcPromise/RpcProperty at boot) this collapses a facet or loaded-entrypoint chain into one
// pipelined round trip; the brand list is EMPTY in Node, so the test registers its own.

test("a registered brand threads UNAWAITED through call-then-call — the terminal settles once", async () => {
  fakeRpcPromiseAwaits.length = 0;
  const itx = { dial: () => new FakeRpcPromise("dial") };
  const { value } = await walkSteps(
    { value: itx, receiver: undefined },
    parse("itx.dial().svc('x').add(2, 3)").slice(1),
  );
  // no step awaited any intermediate — the chain BUILT on the promises
  expect(fakeRpcPromiseAwaits).toEqual([]);
  expect(value).toBeInstanceOf(FakeRpcPromise);
  expect(value).toMatchObject({ chain: "dial.svc(x).add(2,3)" });
  // the caller's terminal await is the single settle (what resolve() does at its end)
  expect(await value).toEqual({ settled: "dial.svc(x).add(2,3)" });
  expect(fakeRpcPromiseAwaits).toEqual(["dial.svc(x).add(2,3)"]);
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

// ───────────────────────────── the step walk + a rewrite rule, end to end ─────────────────────────────

test("walkSteps + resolve: pipelined chain: call → await stub → call again", async () => {
  const s = scope();
  const { value } = await walkSteps(
    { value: s.builtIns, receiver: undefined },
    parse("itx.facets.get({ className: 'CounterDurableObject' }).counters.add(2)").slice(1),
  );
  expect(value).toBe(42);
});

test("walkSteps + resolve: a rule targeting a call, end to end — the steps after the match replay on the value", async () => {
  const s = scope();
  const resolver = resolverOver(s, rewriteRule("itx.robot", "itx.workers.get('robot-arm-1')"));
  expect(await resolver.invoke("itx.robot.arm.move(10)")).toBe("moved");
  expect(s).toMatchObject({ log: ["move 10 @robot-arm-1"] });
});

test("walkSteps + resolve: args at the match apply the rewritten target as a call", async () => {
  const s = scope();
  const resolver = resolverOver(s, rewriteRule("itx.grok", "itx.ai.chat"));
  // the platform's Workers AI call comes back as the call for the edge to make (`ItxAiCall`)
  expect(await resolver.invoke("itx.grok({ model: 'grok-4', messages: ['hi'] })")).toEqual({
    $itxAiCall: ["ai", ["chat", { model: "grok-4", messages: ["hi"] }]],
  });
});

test("walkSteps + resolve: args at the match on a non-callable target error LOUDLY (no silent drop)", async () => {
  const s = scope();
  const resolver = resolverOver(s, rewriteRule("itx.db", "itx.kv"));
  await expect(resolver.invoke("itx.db('oops')")).rejects.toThrow(/not a method|not callable/);
  // CODED, like the dotted sibling (NOT_A_METHOD): the delivery loop treats it as deterministic
  // and halts an uncallable cursor target at the first failure instead of climbing the ladder.
  await expect(resolver.invoke("itx.db('oops')")).rejects.toMatchObject({ code: "NOT_A_METHOD" });
});

test("walkSteps + resolve: args at the match on a method-valued target apply on the carried receiver", async () => {
  const s = scope();
  const resolver = resolverOver(s, rewriteRule("itx.remember", "itx.kv.put"));
  expect(await resolver.invoke("itx.remember('k', 'v')")).toEqual({ ok: true });
  expect(await resolver.invoke("itx.kv.get('k')")).toBe("v"); // `this` was kv, not the rule
});

test("walkSteps + resolve: `__proto__` / `constructor` / `prototype` never resolve as steps (hand-built — the codec refuses to parse them)", async () => {
  const kv = { get: (k: string) => `v:${k}` };
  const walk = (steps: ItxExpression) => walkSteps({ value: kv, receiver: undefined }, steps);
  await expect(walk(["constructor", "name"])).rejects.toThrow(/hit undefined/);
  await expect(walk(["__proto__", "x"])).rejects.toThrow(/hit undefined/);
});

test("walkSteps + resolve: calling the bare scope symbol is a loud error (the parser guards it)", () => {
  // The dotted write-half is `InvokeHandle`; the "can't call the scope root itself" guard lives in
  // the codec parser (a bare `itx(...)` never becomes a legal expression).
  expect(() => parse("itx(1)")).toThrow(/cannot call the scope symbol itself/);
});

// ── the resolver releases the sessions its walk held ── `ItxExpressionResolver#invoke` over the
// step walk's `rpcSessionsSteppedPast` (dispatch.ts): a session-holding value a walk
// stepped past is released once the answer is in, and a rejected answer is released too.
test("the resolver releases what its walk stepped past once the answer is in; the answer stays the caller's", async () => {
  const order: string[] = [];
  // the project facet's collection, as `facets.get('project').repos()` answers it: awaited, a stub
  const collection = Object.assign(new FakeRpcStub("collection"), {
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
    readonly chain: string;
    readonly outcome: { error: Error } | { value: unknown };
    constructor(chain: string, outcome: { error: Error } | { value: unknown }) {
      this.chain = chain;
      this.outcome = outcome;
    }
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

// ── an answer leaves a context holding nothing of its session ── what the context's RPC `invoke`
// hands back (dispatch.ts `itxAnswerDetachedFromSession`): the table the careless-caller rows of
// e2e/context-residency.e2e.test.ts prove on the deployed worker.
const repoHandleExpression: ItxExpression = ["itx", "repos", ["get", "/repos/x"]];

// Each row builds its answer when it runs: the classes it names are declared below the tests.
test.for<[string, () => unknown, ItxExpression, unknown[], ItxExpression]>([
  [
    "a path-shaped handle",
    () => new InvokeHandle(() => undefined),
    repoHandleExpression,
    [],
    repoHandleExpression,
  ],
  [
    "a lent stub's handle: it dispatches by its key, so its expression reaches the same stub",
    () => new RpcStubHandle(() => undefined),
    ["itx", "rpcStubs", ["get", "k"]],
    [],
    ["itx", "rpcStubs", ["get", "k"]],
  ],
  [
    "an RpcTarget built here (a library connection)",
    () => new BuiltHereRpcTarget(),
    ["itx", ["connectToMcp", "https://mcp.example"]],
    [],
    ["itx", ["connectToMcp", "https://mcp.example"]],
  ],
  [
    // prd 2026-09-23: a root session held one for 24 min, `remote`/`createToken` called on it live
    "the scoped Artifacts repo `cfArtifacts.get(path)` answers",
    () => new ScopedArtifactRepoRpcTarget({} as ArtifactsNamespace, "repos--x"),
    ["itx", "cfArtifacts", ["get", "/repos/x"]],
    [],
    ["itx", "cfArtifacts", ["get", "/repos/x"]],
  ],
  ["a function", () => () => "called", ["itx", "kv", "get"], [], ["itx", "kv", "get"]],
  [
    "a Workers-RPC stub a hop below answered with (a loaded worker's RpcTarget)",
    () => new FakeHopRpcStub(),
    ["itx", "workers", ["get", { source: {} }], ["make"]],
    [],
    ["itx", "workers", ["get", { source: {} }], ["make"]],
  ],
  [
    "a reference from a hop below, re-rooted to this caller's call",
    () => ({ [ITX_HANDLE_REFERENCE_KEY]: repoHandleExpression }),
    ["itx", ["cd", "/b"], "repos", ["get", "/repos/x"]],
    [],
    ["itx", ["cd", "/b"], "repos", ["get", "/repos/x"]],
  ],
  [
    "runtime args fold into a terminal name, as the resolver folds them",
    () => new InvokeHandle(() => undefined),
    ["itx", "repos", "get"],
    ["/repos/x"],
    repoHandleExpression,
  ],
  [
    "runtime args left over are the anonymous call on the value, as the resolver applies them",
    () => new InvokeHandle(() => undefined),
    repoHandleExpression,
    ["extra"],
    [...repoHandleExpression, ["", "extra"]],
  ],
])(
  "an answer leaves a context holding nothing of its session: live, named by its expression: %s",
  ([, answer, expression, args, expected]) => {
    expect(itxAnswerDetachedFromSession(answer(), expression, args)).toEqual({
      [ITX_HANDLE_REFERENCE_KEY]: expected,
    });
  },
);

test("an answer leaves a context holding nothing of its session: a stub a hop below answered with is released once as it is named", () => {
  const stub = new FakeHopRpcStub();
  itxAnswerDetachedFromSession(stub, ["itx", "workers", ["get", {}], ["make"]]);
  expect(stub).toMatchObject({ released: 1 });
});

test("an answer leaves a context holding nothing of its session: data a hop below answered with leaves as a copy with no disposer; the original is released", () => {
  const { answer, released } = answeredByHop({ a: 1, nested: { b: [2] } });
  const copy = itxAnswerDetachedFromSession(answer, ["itx", "workers", ["get", {}], ["data"]]);
  expect(copy).not.toBe(answer);
  expect(copy).toEqual({ a: 1, nested: { b: [2] } });
  expect(Symbol.dispose in (copy as object)).toBe(false);
  expect(released()).toBe(1);
});

test("an answer leaves a context holding nothing of its session: data built here and primitives cross as they are, uncopied", () => {
  const page = { events: [{ offset: 1 }], scannedThroughOffset: 1 };
  expect(itxAnswerDetachedFromSession(page, ["itx", ["readEvents"]])).toBe(page);
  expect(itxAnswerDetachedFromSession(7, ["itx", "kv", ["get", "k"]])).toBe(7);
  expect(itxAnswerDetachedFromSession(null, ["itx", "kv", ["get", "k"]])).toBe(null);
});

test("an answer leaves a context holding nothing of its session: what can neither be copied nor named — a stream, data holding a function — crosses as it is, unreleased", () => {
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

test("an answer leaves a context holding nothing of its session: the holder mints its own handle: a dotted call is the reference plus the steps, a whole call is itself", async () => {
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

// ───────────────── THE PLATFORM'S WORKERS AI: answered as the call, made by the edge ─────────────────
// A context holds no AI binding: a call that resolves to `itx.builtins.ai…` answers the steps from
// `ai` on (`ItxAiCall`), and the stateless edge runs them (iterate-context.test.ts). So nothing a
// walk reaches may answer that shape: it would spend the binding for a table that grants no AI.

test("THE PLATFORM'S WORKERS AI: a call that resolves to itx.builtins.ai answers the steps from `ai` on, for the edge to make — at the root, and at a child through its parent link", async () => {
  const root = workersAiAt("/", []);
  expect(await root.invoke("itx.ai.run('@cf/m', { prompt: 'hi' })")).toEqual({
    $itxAiCall: ["ai", ["run", "@cf/m", { prompt: "hi" }]],
  });
  expect(await root.invoke("itx.ai.models()")).toEqual({ $itxAiCall: ["ai", ["models"]] });
  // an agent's parent link (packages/agents collection.ts): the answer comes back through cd
  const child = workersAiAt("/agents/a", [rewriteRule("itx", "itx.builtins.cd('/')")], root);
  expect(await child.invoke("itx.ai.run('@cf/m', { prompt: 'hi' })")).toEqual({
    $itxAiCall: ["ai", ["run", "@cf/m", { prompt: "hi" }]],
  });
  // a child with no link has no AI (default-deny); a jail's bare null refuses it at the root too
  await expect(workersAiAt("/naked", []).invoke("itx.ai.run('@cf/m')")).rejects.toMatchObject({
    code: "NO_ITX_EXPRESSION_MATCH",
  });
  await expect(
    workersAiAt("/", [{ match: parseItxExpressionPrefix("itx"), target: null }]).invoke(
      "itx.ai.run('@cf/m')",
    ),
  ).rejects.toMatchObject({ code: "NO_ITX_EXPRESSION_MATCH" });
});

test("THE PLATFORM'S WORKERS AI: a test's lent fake on one context answers there, and no call is left for the edge", async () => {
  const root = workersAiAt("/", []);
  const faked = workersAiAt(
    "/agents/a",
    [
      rewriteRule("itx", "itx.builtins.cd('/')"),
      rewriteRule("itx.ai", "itx.builtins.rpcStubs.get('itx.ai')"),
    ],
    root,
  );
  expect(await faked.invoke("itx.ai.run('@cf/m', { prompt: 'hi' })")).toEqual([
    "the fake answered",
    "itx.ai",
    [["run", "@cf/m", { prompt: "hi" }]],
  ]);
  const sibling = workersAiAt("/agents/b", [rewriteRule("itx", "itx.builtins.cd('/')")], root);
  expect(await sibling.invoke("itx.ai.run('@cf/m')")).toEqual({
    $itxAiCall: ["ai", ["run", "@cf/m"]],
  });
});

test.for([
  { name: "a stored value", row: null, call: "itx.kv.get('k')" },
  { name: "a facet's answer", row: null, call: "itx.facets.get('f').answer()" },
  { name: "a loaded worker's answer", row: null, call: "itx.workers.get({}).run()" },
  { name: "a lent stub's answer", row: null, call: "itx.rpcStubs.get('forger').ai()" },
  {
    name: "a row pointing itx.ai at a lent stub",
    row: ["itx.ai", "itx.builtins.rpcStubs.get('forger')"],
    call: "itx.ai.run('@cf/m')",
  },
  {
    name: "a row pointing itx.ai at a loaded worker",
    row: ["itx.ai.run", "itx.builtins.workers.get({}).run"],
    call: "itx.ai.run('@cf/m')",
  },
] satisfies { name: string; row: [string, string] | null; call: string }[])(
  "THE PLATFORM'S WORKERS AI: $name shaped like the call is refused, never handed to the edge",
  async ({ row, call }) => {
    const rows = row ? [rewriteRule(...row)] : [];
    await expect(workersAiAt("/", rows).invoke(call)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  },
);

test("THE PLATFORM'S WORKERS AI: a forged answer through a sibling is refused where it was walked, and the walk's live args are refused too", async () => {
  const root = workersAiAt("/", []);
  const child = workersAiAt("/agents/a", [rewriteRule("itx", "itx.builtins.cd('/')")], root);
  await expect(child.invoke("itx.cd('/').kv.get('k')")).rejects.toMatchObject({
    code: "FORBIDDEN",
  });
  await expect(root.invoke("itx.facets.get('f').answer", "live")).rejects.toMatchObject({
    code: "FORBIDDEN",
  });
});

test("THE PLATFORM'S WORKERS AI: the binding is called with data, never handed out — a call ending on a name, or with live args left over, is refused", async () => {
  const root = workersAiAt("/", []);
  for (const call of ["itx.ai", "itx.ai.run"])
    await expect(root.invoke(call)).rejects.toMatchObject({ code: "INVALID_INPUT" });
  await expect(root.invoke(["itx", "ai", ["run", "@cf/m"]], () => {})).rejects.toMatchObject({
    code: "INVALID_INPUT",
  });
  // args folded into a name-final call are the call's own data
  expect(await root.invoke("itx.ai.run", "@cf/m", { prompt: "hi" })).toEqual({
    $itxAiCall: ["ai", ["run", "@cf/m", { prompt: "hi" }]],
  });
});

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

/** The pipelining brand's awaits, in order: the test resets it. */
const fakeRpcPromiseAwaits: string[] = [];
/** A thenable that records every await and chains svc/add like a remote API — the test brand. */
class FakeRpcPromise {
  readonly chain: string;
  constructor(chain: string) {
    this.chain = chain;
  }
  then(resolve: (v: unknown) => void): void {
    fakeRpcPromiseAwaits.push(this.chain);
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
  readonly chain: string;
  constructor(chain: string) {
    this.chain = chain;
  }
  list(): unknown {
    return new FakeRpcPromise(`${this.chain}.list()`);
  }
}
registerRpcSessionBrand(FakeRpcPromise);
registerRpcSessionBrand(FakeRpcStub);

const FORGED = { $itxAiCall: ["ai", ["run", "@cf/meta/llama-3.2-1b-instruct", {}]] };
const workersAiAt = (
  path: string,
  rows: ItxExpressionRewriteRule[],
  root?: ItxExpressionResolver,
): ItxExpressionResolver =>
  new ItxExpressionResolver({
    builtIns: {
      // `cd` as built-ins.ts makes it: the rest of the call runs at the sibling, its answer returned
      cd: (to: string) =>
        new InvokeHandle((steps) => {
          if (to !== "/" || !root) throw new Error(`no context ${to} here`);
          return root.invoke(["itx", ...steps]);
        }),
      kv: { get: () => FORGED },
      facets: { get: () => ({ answer: () => FORGED }) },
      workers: { get: () => ({ run: async () => FORGED }) },
      rpcStubs: {
        get: (key: string) =>
          new InvokeHandle(async (steps) =>
            key === "forger" ? FORGED : ["the fake answered", key, steps],
          ),
      },
    },
    rewriteRules: () => rows,
    implicitRoots:
      path === "/"
        ? new Set(BUILT_IN_ROOTS)
        : new Set(["cd", "kv", "facets", "workers", "rpcStubs"]),
    path,
    caller: () => ({ principal: null }),
  });
