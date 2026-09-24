// context/expression.test.ts — the dispatch half of the expression machinery, where it needs apps/os:
// the step walk under a rewrite rule through `ItxExpressionResolver` over a fake built-ins scope, the
// resolver releasing what its walk held, and what a context's `invoke` answer leaves of a session.
// The codec, the walk's pipelining contract and the prototype hop are packages/iterate
// src/next/expression.test.ts; rule MATCHING is itx-expression-rewriting.test.ts.

import { describe, expect, test } from "vitest";
import { RpcTarget } from "capnweb";
import {
  InvokeHandle,
  RpcStubHandle,
  ITX_HANDLE_REFERENCE_KEY,
  itxAnswerDetachedFromSession,
  materializeItxHandleReference,
  parse,
  parseItxExpressionPrefix,
  type ItxExpression,
  registerPipelinedRpcBrand,
  registerRpcSessionBrand,
  walkSteps,
} from "iterate/next/expression";
import {
  BUILT_IN_ROOTS,
  ItxExpressionResolver,
  type ItxExpressionRewriteRule,
} from "./itx-expression-rewriting.ts";
import { ScopedArtifactRepoRpcTarget, type ArtifactsNamespace } from "./cf-artifacts.ts";

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

// ── the resolver releases the sessions its walk held ── `ItxExpressionResolver#invoke` over the
// step walk's `rpcSessionsSteppedPast` (iterate/next/expression.ts): a session-holding value a walk
// stepped past is released once the answer is in, and a rejected answer is released too.
test("the resolver releases what its walk stepped past once the answer is in; the answer stays the caller's", async () => {
  const order: string[] = [];
  // the project facet's collection, as `facets.get('project').repos()` answers it: awaited, a stub
  const collection = Object.assign(new FakeRpcStub(), {
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

/** A stub an awaited call answered with (a facet's collection): it holds its session until
 *  disposed — as iterate-context.ts registers the native RpcStub. */
class FakeRpcStub {}
registerRpcSessionBrand(FakeRpcStub);
