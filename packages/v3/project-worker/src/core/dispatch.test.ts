// Executable spec for the capability-path matcher + the expression evaluator/dispatcher.
import { describe, expect, test } from "vitest";
import { apply, evaluate, match, registerPipelinedRpcBrand } from "./dispatch.ts";
import { parse, parseCapabilityPath } from "./expression.ts";

// ───────────────────────────── capability-path matching ─────────────────────────────
// THE RULE, whole: segment by segment from the start; the longest matching path wins; ties go
// to the newest mount. The FINAL segment may consume a call step's args (the boundary args).

describe("match", () => {
  test.each([
    [
      "plain alias: remainder replays",
      "itx.db",
      "itx.db.get('x')",
      { segments: 2, remainder: [["get", "x"]] },
    ],
    [
      "boundary args: path name, call invokes",
      "itx.grok",
      "itx.grok({ messages: [] })",
      { segments: 2, boundaryArgs: [{ messages: [] }], remainder: [] },
    ],
    [
      "bare default route claims everything",
      "itx",
      "itx.some.thing.deep('x')",
      { segments: 1, remainder: ["some", "thing", ["deep", "x"]] },
    ],
    [
      "deep path, call at the boundary",
      "itx.subscribers.foo",
      "itx.subscribers.foo('batch')",
      { segments: 3, boundaryArgs: ["batch"], remainder: [] },
    ],
  ])("%s", (_label, path, call, expected) => {
    const m = match(parseCapabilityPath(path as string), parse(call as string))!;
    expect(m).not.toBeNull();
    const e = expected as { segments: number; boundaryArgs?: unknown[]; remainder: unknown[] };
    if (e.boundaryArgs) expect(m.boundaryArgs).toEqual(e.boundaryArgs);
    expect(m.remainder).toEqual(e.remainder);
  });

  test.each([
    ["name mismatch", "itx.f", "itx.g()"],
    ["call consume is FINAL-segment only", "itx.a.b", "itx.a('x').b"],
    ["path longer than call", "itx.a.b.c", "itx.a.b"],
  ])("rejects: %s", (_label, path, call) => {
    expect(match(parseCapabilityPath(path as string), parse(call as string))).toBeNull();
  });

  test("ranking basis: the longer path consumes more of the call (less remainder to replay)", () => {
    // #route ranks by the winning mount's own `path.length`; a longer matching path claims more
    // segments, so it leaves a SHORTER remainder — the observable proof that it matched more.
    const call = parse("itx.robots.abc.ping()");
    const long = match(parseCapabilityPath("itx.robots.abc"), call)!;
    const short = match(parseCapabilityPath("itx.robots"), call)!;
    expect(long.remainder.length).toBeLessThan(short.remainder.length);
  });
});

// ───────────────────────────── evaluate + apply (end to end) ─────────────────────────────

const scope = () => {
  const log: string[] = [];
  const kvStore = new Map<string, string>();
  return {
    log,
    builtins: {
      kv: {
        get: (k: string) => kvStore.get(k),
        put: (k: string, v: string) => {
          kvStore.set(k, v);
          return { ok: true };
        },
      },
    },
    itx: {
      openai: {
        chat: (o: { model: string; messages?: unknown[] }) => `chat(${o.model})`,
      },
      robots: {
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

describe("evaluate/apply", () => {
  test("pipelined chain: call → await stub → call again", async () => {
    const s = scope();
    const { value } = await evaluate(
      s,
      parse("itx.facets.get({ className: 'Counter' }).counters.add(2)"),
    );
    expect(value).toBe(42);
  });

  test("alias mount end to end — remainder replays on the live stub", async () => {
    const s = scope();
    const m = match(parseCapabilityPath("itx.robot"), parse("itx.robot.arm.move(10)"))!;
    const result = await apply(s, parse("itx.robots.get('robot-arm-1')"), m);
    expect(result).toBe("moved");
    expect(s.log).toEqual(["move 10 @robot-arm-1"]);
  });

  test("boundary args apply the evaluated target as a call", async () => {
    const s = scope();
    const m = match(
      parseCapabilityPath("itx.grok"),
      parse("itx.grok({ model: 'grok-4', messages: ['hi'] })"),
    )!;
    const result = await apply(s, parse("itx.openai.chat"), m);
    expect(result).toBe("chat(grok-4)");
  });

  test("boundary args on a non-callable target error LOUDLY (no silent drop)", async () => {
    const s = scope();
    const m = match(parseCapabilityPath("itx.db"), parse("itx.db('oops')"))!;
    await expect(apply(s, parse("builtins.kv"), m)).rejects.toThrow(/not callable/);
  });

  test("boundary args on a method-valued target apply on the carried receiver", async () => {
    const s = scope();
    const m = match(parseCapabilityPath("itx.log"), parse("itx.log({ type: 'hi' })"))!;
    const result = await apply(s, parse("itx.append"), m);
    expect(result).toEqual({ offset: 1 });
    expect(s.log).toEqual([`append {"type":"hi"}`]);
  });

  test("the built-ins are only reachable when in scope (the provenance gate)", async () => {
    const s = scope();
    const eventScope = { itx: s.itx }; // event provenance: no built-in keys at all
    await expect(evaluate(eventScope, parse("builtins.kv.get('x')"))).rejects.toThrow(
      /not in scope/,
    );
  });

  test("inherited built-ins are not capability surface (the RPC exposure doctrine)", async () => {
    const s = { itx: { kv: { get: (k: string) => `v:${k}` } } };
    // an inherited method errs EXACTLY like a missing one — callers cannot probe
    await expect(evaluate(s, ["itx", "kv", ["toString"]])).rejects.toThrow(/is not a method/);
    await expect(evaluate(s, ["itx", "kv", ["hasOwnProperty", "get"]])).rejects.toThrow(
      /is not a method/,
    );
    // the magic names never resolve — a property step yields undefined → the null guard
    await expect(evaluate(s, ["itx", "kv", "constructor", "name"])).rejects.toThrow(
      /hit undefined/,
    );
    // an OWN override with the same name passes — the doctrine allows what the object chose
    const own = { itx: { kv: { toString: () => "mine" } } };
    await expect(evaluate(own, ["itx", "kv", ["toString"]])).resolves.toMatchObject({
      value: "mine",
    });
  });

  test("calling the bare scope symbol is a loud error (the parser guards it)", () => {
    // The dotted write-half is now `InvokeHandle`; the "can't call the scope root itself" guard
    // lives in the codec parser (a bare `itx(...)` never becomes a legal expression).
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

  test("a registered brand threads UNAWAITED through call-then-call — the terminal settles once", async () => {
    FakeRpcPromise.awaited = [];
    const scope = { itx: { dial: () => new FakeRpcPromise("dial") } };
    const { value } = await evaluate(scope, parse("itx.dial().svc('x').add(2, 3)"));
    // no step awaited any intermediate — the chain BUILT on the promises
    expect(FakeRpcPromise.awaited).toEqual([]);
    expect(value).toBeInstanceOf(FakeRpcPromise);
    expect((value as FakeRpcPromise).chain).toBe("dial.svc(x).add(2,3)");
    // the caller's terminal await is the single settle (what apply() does at its end)
    expect(await value).toEqual({ settled: "dial.svc(x).add(2,3)" });
    expect(FakeRpcPromise.awaited).toEqual(["dial.svc(x).add(2,3)"]);
  });

  test("an UNREGISTERED thenable keeps the default: awaited at every step", async () => {
    const awaited: string[] = [];
    const plain = (chain: string) => ({
      then(resolve: (v: unknown) => void) {
        awaited.push(chain);
        resolve({ svc: (name: string) => plain(`${chain}.svc(${name})`) });
      },
    });
    const scope = { itx: { dial: () => plain("dial") } };
    const { value } = await evaluate(scope, parse("itx.dial().svc('x')"));
    // the walk awaited the intermediate before stepping into it, and settled the tail too
    expect(awaited).toEqual(["dial", "dial.svc(x)"]);
    expect(value).toEqual({ svc: expect.any(Function) });
  });
});
