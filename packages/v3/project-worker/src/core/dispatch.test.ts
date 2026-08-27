// Executable spec for the capability-path matcher + the expression evaluator/dispatcher.
import { describe, expect, test } from "vitest";
import { apply, evaluate, match, pathProxy } from "./dispatch.ts";
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
    expect(m.matchedSegments).toBe(e.segments);
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

  test("ranking: the longer path wins", () => {
    const call = parse("itx.connections.abc.ping()");
    const long = match(parseCapabilityPath("itx.connections.abc"), call)!;
    const short = match(parseCapabilityPath("itx.connections"), call)!;
    expect(long.matchedSegments).toBeGreaterThan(short.matchedSegments);
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
        put: (k: string, v: string) => (kvStore.set(k, v), { ok: true }),
      },
    },
    itx: {
      openai: {
        chat: (o: { model: string; messages?: unknown[] }) => `chat(${o.model})`,
      },
      connections: {
        get: (key: string) => ({
          ping: () => `pong:${key}`,
          arm: { move: (n: number) => (log.push(`move ${n} @${key}`), "moved") },
        }),
      },
      // a stub-returning chain — pipelining through an async hop
      workers: {
        get: async (_ref: unknown) => ({ counters: { add: async (n: number) => 40 + n } }),
      },
      append: (e: unknown) => (log.push(`append ${JSON.stringify(e)}`), { offset: 1 }),
    },
  };
};

describe("evaluate/apply", () => {
  test("pipelined chain: call → await stub → call again", async () => {
    const s = scope();
    const { value } = await evaluate(
      s,
      parse("itx.workers.get({ type: 'stateful' }).counters.add(2)"),
    );
    expect(value).toBe(42);
  });

  test("alias mount end to end — remainder replays on the live stub", async () => {
    const s = scope();
    const m = match(parseCapabilityPath("itx.robot"), parse("itx.robot.arm.move(10)"))!;
    const result = await apply(s, parse("itx.connections.get('robot-arm-1')"), m);
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

  test("calling the bare scope symbol is a loud error", () => {
    const itx = pathProxy(() => "unreachable") as (...args: unknown[]) => unknown;
    expect(() => itx(1)).toThrow(/cannot call the scope symbol itself/);
  });
});
