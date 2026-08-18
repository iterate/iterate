// The jam's worked examples as executable spec. Each block names the example it proves.
import { describe, expect, test } from "vitest";
import {
  apply,
  compareSpecificity,
  evaluate,
  match,
  parse,
  pathProxy,
  print,
  substitute,
  toExpression,
  type Expression,
} from "./expression.ts";

// ───────────────────────────── the two halves round-trip ─────────────────────────────

describe("parse ⇄ print", () => {
  const cases: [string, Expression][] = [
    ["itx.kv", ["itx", "kv"]],
    ["roots.kv", ["roots", "kv"]],
    ["itx.streams.get('/logs')", ["itx", "streams", ["get", "/logs"]]],
    ["roots.binding('CONTROL_PLANE')", ["roots", ["binding", "CONTROL_PLANE"]]],
    ["itx.cd('/')", ["itx", ["cd", "/"]]],
    [
      "itx.openai.chat({ model: 'grok-4', messages: ?0 })",
      ["itx", "openai", ["chat", { model: "grok-4", messages: { "?": 0 } }]],
    ],
    ["itx.agents.get(?name)", ["itx", "agents", ["get", { "?": "name" }]]],
    ["itx.clients.get('robot-arm-1')", ["itx", "clients", ["get", "robot-arm-1"]]],
    ["itx.worker.slackDigest(...?)", ["itx", "worker", ["slackDigest", { "...": true }]]],
    [
      "itx.openai.chat({ ...?, model: 'grok-4' })",
      ["itx", "openai", ["chat", { "...": 0, model: "grok-4" }]],
    ],
    [
      "itx.math.add(1, 2.5, true, null, [1, 'a'])",
      ["itx", "math", ["add", 1, 2.5, true, null, [1, "a"]]],
    ],
  ];
  for (const [s, e] of cases) {
    test(s, () => {
      expect(parse(s)).toEqual(e);
      expect(parse(print(e))).toEqual(e); // canonical round-trip
    });
  }

  test("`?` auto-numbers left-to-right across the expression", () => {
    expect(parse("itx.f(?, ?)")).toEqual(["itx", ["f", { "?": 0 }, { "?": 1 }]]);
  });

  test("double quotes, escapes, whitespace", () => {
    expect(parse(`itx.kv.put( "a'b" , 'c\\'d' )`)).toEqual(["itx", "kv", ["put", "a'b", "c'd"]]);
  });

  test("reserved names rejected", () => {
    expect(() => parse("itx.__proto__.x")).toThrow(/reserved/);
  });

  test("trailing garbage rejected", () => {
    expect(() => parse("itx.kv extra")).toThrow(/trailing/);
  });

  test("toExpression accepts either half", () => {
    expect(toExpression("itx.kv")).toEqual(["itx", "kv"]);
    expect(toExpression(["itx", "kv"])).toEqual(["itx", "kv"]);
  });

  test("bare call on the scope symbol is a loud error — both halves", () => {
    expect(() => parse("itx(1)")).toThrow(/cannot call the scope symbol itself/);
    const itx = pathProxy(() => "unreachable") as (...args: unknown[]) => unknown;
    expect(() => itx(1)).toThrow(/cannot call the scope symbol itself/);
  });
});

// ───────────────────────────── matching + specificity ─────────────────────────────

describe("match", () => {
  test("ex 1 — plain alias: remainder replays", () => {
    const m = match(parse("itx.db"), parse("itx.db.get('x')"))!;
    expect(m.remainder).toEqual([["get", "x"]]);
    expect(m.boundaryArgs).toBeUndefined();
  });

  test("ex 3 — boundary args: pattern name, call invokes", () => {
    const m = match(parse("itx.grok"), parse("itx.grok({ messages: [] })"))!;
    expect(m.boundaryArgs).toEqual([{ messages: [] }]);
    expect(m.remainder).toEqual([]);
  });

  test("ex 6 — capture binds and is available", () => {
    const m = match(parse("itx.agents.get(?name)"), parse("itx.agents.get('blah').ask('hi')"))!;
    expect(m.captures).toEqual({ name: "blah" });
    expect(m.remainder).toEqual([["ask", "hi"]]);
  });

  test("ex 7 — bare default route claims everything, whole call is the remainder", () => {
    const m = match(parse("itx"), parse("itx.some.thing.deep('x')"))!;
    expect(m.remainder).toEqual(["some", "thing", ["deep", "x"]]);
  });

  test("ex 8 — literal arg beats bare prefix", () => {
    const call = parse("itx.clients.get('robot-arm-1').ping()");
    const specific = match(parse("itx.clients.get('robot-arm-1')"), call)!;
    const general = match(parse("itx.clients"), call)!;
    expect(compareSpecificity(specific.specificity, general.specificity)).toBeGreaterThan(0);
  });

  test("literal arg beats hole at the same depth", () => {
    const call = parse("itx.clients.get('robot-arm-1')");
    const literal = match(parse("itx.clients.get('robot-arm-1')"), call)!;
    const holed = match(parse("itx.clients.get(?k)"), call)!;
    expect(compareSpecificity(literal.specificity, holed.specificity)).toBeGreaterThan(0);
  });

  test("name-only consume is FINAL-step only", () => {
    expect(match(parse("itx.a.b"), parse("itx.a('x').b"))).toBeNull();
  });

  test("arity: no rest hole → exact arg count", () => {
    expect(match(parse("itx.f(?x)"), parse("itx.f(1, 2)"))).toBeNull();
    expect(match(parse("itx.f(?x, ...?)"), parse("itx.f(1, 2, 3)"))).not.toBeNull();
  });

  test("method mismatch / literal mismatch reject", () => {
    expect(match(parse("itx.f('a')"), parse("itx.f('b')"))).toBeNull();
    expect(match(parse("itx.f()"), parse("itx.g()"))).toBeNull();
  });
});

// ───────────────────────────── substitution ─────────────────────────────

describe("substitute", () => {
  test("ex 3 — frozen model, caller messages fill the hole", () => {
    const target = parse("itx.openai.chat({ model: 'grok-4', messages: ?0 })");
    expect(substitute(target, { args: [["msg!"]], captures: {} })).toEqual([
      "itx",
      "openai",
      ["chat", { model: "grok-4", messages: ["msg!"] }],
    ]);
  });

  test("ex 4 — spread-merge: FROZEN WINS on collision", () => {
    const target = parse("itx.openai.chat({ ...?, model: 'grok-4' })");
    const [, , chat] = substitute(target, {
      args: [{ model: "evil", temperature: 0.5 }],
      captures: {},
    }) as [string, string, [string, Record<string, unknown>]];
    expect(chat[1]).toEqual({ model: "grok-4", temperature: 0.5 });
  });

  test("ex 6 — capture referenced on the target side", () => {
    const target = parse("itx.cd('/agents', ?name)");
    expect(substitute(target, { args: [], captures: { name: "blah" } })).toEqual([
      "itx",
      ["cd", "/agents", "blah"],
    ]);
  });

  test("rest splices remaining args after the highest numbered hole", () => {
    const target = parse("itx.f(?0, ...?)");
    expect(substitute(target, { args: [1, 2, 3], captures: {} })).toEqual(["itx", ["f", 1, 2, 3]]);
  });

  test("rest scan finds NESTED numbered holes — f({ a: ?0 }, ...?) never splices args[0] twice", () => {
    const target = parse("itx.f({ a: ?0 }, ...?)");
    expect(substitute(target, { args: ["first", "second"], captures: {} })).toEqual([
      "itx",
      ["f", { a: "first" }, "second"],
    ]);
    // $-escaped data that merely LOOKS like a hole must not shift the splice point
    const escaped: Expression = ["itx", ["f", { $: { "?": 7 } }, { "...": true }]];
    expect(substitute(escaped, { args: ["a", "b"], captures: {} })).toEqual([
      "itx",
      ["f", { "?": 7 }, "a", "b"],
    ]);
  });

  test("$ literal escape passes tagged-looking data through verbatim", () => {
    const target: Expression = ["itx", ["f", { $: { "?": 0 } }]];
    expect(substitute(target, { args: ["ignored"], captures: {} })).toEqual([
      "itx",
      ["f", { "?": 0 }],
    ]);
  });

  test("unbound capture throws loudly", () => {
    expect(() => substitute(parse("itx.f(?nope)"), { args: [], captures: {} })).toThrow(
      /unbound capture/,
    );
  });
});

// ───────────────────────────── evaluate + apply (end to end) ─────────────────────────────

const scope = () => {
  const log: string[] = [];
  const kvStore = new Map<string, string>();
  return {
    log,
    roots: {
      kv: {
        get: (k: string) => kvStore.get(k),
        put: (k: string, v: string) => (kvStore.set(k, v), { ok: true }),
      },
    },
    itx: {
      openai: {
        chat: (o: { model: string; messages?: unknown[] }) => `chat(${o.model})`,
      },
      clients: {
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
  test("ex 12 — pipelined chain: call → await stub → call again", async () => {
    const s = scope();
    const { value } = await evaluate(
      s,
      parse("itx.workers.get({ type: 'stateful' }).counters.add(2)"),
    );
    expect(value).toBe(42);
  });

  test("ex 1+5 end-to-end — alias mount, remainder replays on the live stub", async () => {
    const s = scope();
    const pattern = parse("itx.robot");
    const target = parse("itx.clients.get('robot-arm-1')");
    const call = parse("itx.robot.arm.move(10)");
    const m = match(pattern, call)!;
    const result = await apply(s, substitute(target, { args: [], captures: m.captures }), m);
    expect(result).toBe("moved");
    expect(s.log).toEqual(["move 10 @robot-arm-1"]);
  });

  test("ex 3 end-to-end — boundary args flow through holes", async () => {
    const s = scope();
    const m = match(parse("itx.grok"), parse("itx.grok({ messages: ['hi'] })"))!;
    const target = substitute(parse("itx.openai.chat({ model: 'grok-4', ...? })"), {
      args: m.boundaryArgs!,
      captures: m.captures,
    });
    const result = await apply(s, target, { ...m, boundaryArgs: undefined });
    expect(result).toBe("chat(grok-4)");
  });

  test("boundary args on a non-callable target error LOUDLY (no silent drop)", async () => {
    const s = scope();
    const m = match(parse("itx.db"), parse("itx.db('oops')"))!;
    await expect(apply(s, parse("roots.kv"), m)).rejects.toThrow(/not callable/);
  });

  test("boundary args on a method-valued target apply on the carried receiver", async () => {
    const s = scope();
    const m = match(parse("itx.log"), parse("itx.log({ type: 'hi' })"))!;
    const result = await apply(s, parse("itx.append"), m);
    expect(result).toEqual({ offset: 1 });
    expect(s.log).toEqual([`append {"type":"hi"}`]);
  });

  test("roots is only reachable when in scope (provenance gate)", async () => {
    const s = scope();
    const eventScope = { itx: s.itx }; // event provenance: no `roots` symbol at all
    await expect(evaluate(eventScope, parse("roots.kv.get('x')"))).rejects.toThrow(/not in scope/);
  });
});
