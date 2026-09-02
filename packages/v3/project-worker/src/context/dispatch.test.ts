// Executable spec for the capability-path matcher + the step walk (and the resolver over a fake
// built-ins scope, where a walk is only observable through a mount).
import { describe, expect, test } from "vitest";
import type { Mount } from "../stream/core-processor.ts";
import { CapabilityResolver } from "./capability-table.ts";
import { match, registerPipelinedRpcBrand, walkSteps } from "./dispatch.ts";
import { parse, parseCapabilityPath, type Expression } from "./expression.ts";

// ───────────────────────────── capability-path matching ─────────────────────────────
// THE RULE, whole: segment by segment from the start; the longest matching path wins; ties go
// to the newest mount. The FINAL segment may consume a call step's args (the args at the mount).

describe("match", () => {
  test.each([
    [
      "a mount targeting another capability: the steps after the mount replay",
      "itx.db",
      "itx.db.get('x')",
      { segments: 2, stepsAfterMount: [["get", "x"]] },
    ],
    [
      "args at the mount: path name, call invokes",
      "itx.grok",
      "itx.grok({ messages: [] })",
      { segments: 2, argsAtMount: [{ messages: [] }], stepsAfterMount: [] },
    ],
    [
      "bare default route claims everything",
      "itx",
      "itx.some.thing.deep('x')",
      { segments: 1, stepsAfterMount: ["some", "thing", ["deep", "x"]] },
    ],
    [
      "deep path, call at the mount",
      "itx.robots.arm",
      "itx.robots.arm('batch')",
      { segments: 3, argsAtMount: ["batch"], stepsAfterMount: [] },
    ],
  ])("%s", (_label, path, call, expected) => {
    const m = match(parseCapabilityPath(path as string), parse(call as string))!;
    expect(m).not.toBeNull();
    const e = expected as { segments: number; argsAtMount?: unknown[]; stepsAfterMount: unknown[] };
    if (e.argsAtMount) expect(m.argsAtMount).toEqual(e.argsAtMount);
    expect(m.stepsAfterMount).toEqual(e.stepsAfterMount);
  });

  test.each([
    ["name mismatch", "itx.f", "itx.g()"],
    ["call consume is FINAL-segment only", "itx.a.b", "itx.a('x').b"],
    ["path longer than call", "itx.a.b.c", "itx.a.b"],
  ])("rejects: %s", (_label, path, call) => {
    expect(match(parseCapabilityPath(path as string), parse(call as string))).toBeNull();
  });

  test("ranking basis: the longer path consumes more of the call (fewer steps left to replay)", () => {
    // route ranks by the winning mount's own `path.length`; a longer matching path claims more
    // segments, so it leaves FEWER steps after the mount — the observable proof that it matched more.
    const call = parse("itx.robots.abc.ping()");
    const long = match(parseCapabilityPath("itx.robots.abc"), call)!;
    const short = match(parseCapabilityPath("itx.robots"), call)!;
    expect(long.stepsAfterMount.length).toBeLessThan(short.stepsAfterMount.length);
  });
});

// ───────────────────────────── the step walk + a mount, end to end ─────────────────────────────

/** A fake built-ins scope: enough physical layer to walk into. `kv` is `this`-dependent on purpose
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
const mount = (path: string, target: string, providedAtOffset = 1): Mount => ({
  path: parseCapabilityPath(path),
  target: parse(target),
  providedAtOffset,
});
const resolverOver = (s: ReturnType<typeof scope>, ...mounts: Mount[]) =>
  new CapabilityResolver({ builtIns: s.builtIns, mounts: () => mounts });

describe("walkSteps + resolve", () => {
  test("pipelined chain: call → await stub → call again", async () => {
    const s = scope();
    const { value } = await walkSteps(
      { value: s.builtIns, receiver: undefined },
      parse("itx.facets.get({ className: 'CounterDurableObject' }).counters.add(2)").slice(1),
      "expression",
    );
    expect(value).toBe(42);
  });

  test("a mount targeting another mount, end to end — the steps after the mount replay on the live stub", async () => {
    const s = scope();
    const resolver = resolverOver(s, mount("itx.robot", "itx.robots.get('robot-arm-1')"));
    expect(await resolver.resolve("itx.robot.arm.move(10)")).toBe("moved");
    expect(s.log).toEqual(["move 10 @robot-arm-1"]);
  });

  test("args at the mount apply the resolved target as a call", async () => {
    const s = scope();
    const resolver = resolverOver(s, mount("itx.grok", "itx.openai.chat"));
    expect(await resolver.resolve("itx.grok({ model: 'grok-4', messages: ['hi'] })")).toBe(
      "chat(grok-4)",
    );
  });

  test("args at the mount on a non-callable target error LOUDLY (no silent drop)", async () => {
    const s = scope();
    const resolver = resolverOver(s, mount("itx.db", "itx.kv"));
    await expect(resolver.resolve("itx.db('oops')")).rejects.toThrow(/not callable/);
  });

  test("args at the mount on a method-valued target apply on the carried receiver", async () => {
    const s = scope();
    const resolver = resolverOver(s, mount("itx.remember", "itx.kv.put"));
    expect(await resolver.resolve("itx.remember('k', 'v')")).toEqual({ ok: true });
    expect(await resolver.resolve("itx.kv.get('k')")).toBe("v"); // `this` was kv, not the mount
  });

  test("inherited built-ins are not capability surface (the RPC exposure doctrine)", async () => {
    const kv = { get: (k: string) => `v:${k}` };
    const walk = (steps: Expression) =>
      walkSteps({ value: kv, receiver: undefined }, steps, "expression");
    // an inherited method errs EXACTLY like a missing one — callers cannot probe
    await expect(walk([["toString"]])).rejects.toThrow(/is not a method/);
    await expect(walk([["hasOwnProperty", "get"]])).rejects.toThrow(/is not a method/);
    // the magic names never resolve (the codec refuses to even parse them — these are hand-built
    // steps) — a property step yields undefined → the null guard
    await expect(walk(["constructor", "name"])).rejects.toThrow(/hit undefined/);
    // an OWN override with the same name passes — the doctrine allows what the object chose
    const own = { toString: () => "mine" };
    await expect(
      walkSteps({ value: own, receiver: undefined }, [["toString"]], "expression"),
    ).resolves.toMatchObject({ value: "mine" });
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

  test("a registered brand threads UNAWAITED through call-then-call — the terminal settles once", async () => {
    FakeRpcPromise.awaited = [];
    const itx = { dial: () => new FakeRpcPromise("dial") };
    const { value } = await walkSteps(
      { value: itx, receiver: undefined },
      parse("itx.dial().svc('x').add(2, 3)").slice(1),
      "expression",
    );
    // no step awaited any intermediate — the chain BUILT on the promises
    expect(FakeRpcPromise.awaited).toEqual([]);
    expect(value).toBeInstanceOf(FakeRpcPromise);
    expect((value as FakeRpcPromise).chain).toBe("dial.svc(x).add(2,3)");
    // the caller's terminal await is the single settle (what resolve() does at its end)
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
    const itx = { dial: () => plain("dial") };
    const { value } = await walkSteps(
      { value: itx, receiver: undefined },
      parse("itx.dial().svc('x')").slice(1),
      "expression",
    );
    // the walk awaited the intermediate before stepping into it, and settled the tail too
    expect(awaited).toEqual(["dial", "dial.svc(x)"]);
    expect(value).toEqual({ svc: expect.any(Function) });
  });
});
