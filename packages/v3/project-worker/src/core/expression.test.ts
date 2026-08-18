// The jam's worked examples as executable spec. Each block names the example it proves.
import { describe, expect, test } from "vitest";
import {
  apply,
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

  test("inherited built-ins are not capability surface (the RPC exposure doctrine)", async () => {
    const scope = { itx: { kv: { get: (k: string) => `v:${k}` } } };
    // an inherited method errs EXACTLY like a missing one — callers cannot probe
    await expect(evaluate(scope, ["itx", "kv", ["toString"]])).rejects.toThrow(/is not a method/);
    await expect(evaluate(scope, ["itx", "kv", ["hasOwnProperty", "get"]])).rejects.toThrow(
      /is not a method/,
    );
    // the magic names never resolve — a property step yields undefined → the null guard
    await expect(evaluate(scope, ["itx", "kv", "constructor", "name"])).rejects.toThrow(
      /hit undefined/,
    );
    // an OWN override with the same name passes — the doctrine allows what the object chose
    const own = { itx: { kv: { toString: () => "mine" } } };
    await expect(evaluate(own, ["itx", "kv", ["toString"]])).resolves.toMatchObject({
      value: "mine",
    });
  });

  test("the depth budget: absurd nesting is a loud error, never a stack overflow", () => {
    const deep = "[".repeat(70) + "]".repeat(70);
    expect(() => parse(`itx.f(${deep})`)).toThrow(/nesting exceeds/);
    let nested: unknown = { "?": 0 };
    for (let i = 0; i < 70; i++) nested = { a: nested };
    expect(() => substitute(["itx", ["f", nested]], { args: [1], captures: {} })).toThrow(
      /nesting exceeds/,
    );
  });

  test("$-escapes survive the print⇄parse round trip (frozen data never becomes a live hole)", () => {
    const escaped: Expression = ["itx", ["f", { $: { "?": 0 } }]];
    expect(print(escaped)).toBe("itx.f({ $: ?0 })");
    expect(parse(print(escaped))).toEqual(escaped);
    const nested: Expression = ["itx", ["f", { $: { $: 1 } }]];
    expect(parse(print(nested))).toEqual(nested);
  });

  test("bare call on the scope symbol is a loud error — both halves", () => {
    expect(() => parse("itx(1)")).toThrow(/cannot call the scope symbol itself/);
    const itx = pathProxy(() => "unreachable") as (...args: unknown[]) => unknown;
    expect(() => itx(1)).toThrow(/cannot call the scope symbol itself/);
  });
});

// ───────────────────────────── matching (table-based) ─────────────────────────────
// THE RULE, whole: element by element from the start; longest matching prefix wins; ties go to
// the newest mount. Literal args decide only WHETHER a step matches, never how well.

describe("match", () => {
  test.each([
    [
      "plain alias: remainder replays",
      "itx.db",
      "itx.db.get('x')",
      { steps: 2, remainder: [["get", "x"]] },
    ],
    [
      "boundary args: pattern name, call invokes",
      "itx.grok",
      "itx.grok({ messages: [] })",
      { steps: 2, boundaryArgs: [{ messages: [] }], remainder: [] },
    ],
    [
      "capture binds mid-path",
      "itx.agents.get(?name)",
      "itx.agents.get('blah').ask('hi')",
      { steps: 3, captures: { name: "blah" }, remainder: [["ask", "hi"]] },
    ],
    [
      "mid-path LITERAL call is an ordinary step",
      "itx.streams.get('/bla').append",
      "itx.streams.get('/bla').append({ type: 'x' })",
      { steps: 4, boundaryArgs: [{ type: "x" }], remainder: [] },
    ],
    [
      "bare default route claims everything",
      "itx",
      "itx.some.thing.deep('x')",
      { steps: 1, remainder: ["some", "thing", ["deep", "x"]] },
    ],
    [
      "rest hole accepts extra args",
      "itx.f(?x, ...?)",
      "itx.f(1, 2, 3)",
      { steps: 2, remainder: [] },
    ],
  ])("%s", (_label, pattern, call, expected) => {
    const m = match(parse(pattern as string), parse(call as string))!;
    expect(m).not.toBeNull();
    const e = expected as {
      steps: number;
      captures?: object;
      boundaryArgs?: unknown[];
      remainder: unknown[];
    };
    expect(m.matchedSteps).toBe(e.steps);
    if (e.captures) expect(m.captures).toEqual(e.captures);
    if (e.boundaryArgs) expect(m.boundaryArgs).toEqual(e.boundaryArgs);
    expect(m.remainder).toEqual(e.remainder);
  });

  test.each([
    ["literal arg mismatch", "itx.f('a')", "itx.f('b')"],
    ["method mismatch", "itx.f()", "itx.g()"],
    ["name-only consume is FINAL-step only", "itx.a.b", "itx.a('x').b"],
    ["no rest hole → exact arg count", "itx.f(?x)", "itx.f(1, 2)"],
    ["pattern longer than call", "itx.a.b.c", "itx.a.b"],
  ])("rejects: %s", (_label, pattern, call) => {
    expect(match(parse(pattern as string), parse(call as string))).toBeNull();
  });

  test.each([
    [
      "longer prefix beats shorter",
      "itx.clients.get('robot-arm-1')",
      "itx.clients",
      "itx.clients.get('robot-arm-1').ping()",
    ],
    [
      "a binding call step counts like any other step",
      "itx.agents.get(?name)",
      "itx.agents",
      "itx.agents.get('bob').ask('hi')",
    ],
  ])("ranking: %s", (_label, winner, loser, call) => {
    const w = match(parse(winner as string), parse(call as string))!;
    const l = match(parse(loser as string), parse(call as string))!;
    expect(w.matchedSteps).toBeGreaterThan(l.matchedSteps);
  });

  test("equal-length literal and hole patterns TIE — recency decides (the documented change)", () => {
    const call = parse("itx.clients.get('robot-arm-1')");
    const literal = match(parse("itx.clients.get('robot-arm-1')"), call)!;
    const holed = match(parse("itx.clients.get(?k)"), call)!;
    expect(literal.matchedSteps).toBe(holed.matchedSteps);
  });
});

// ───────────────────────────── substitution ─────────────────────────────

describe("substitute (table-based)", () => {
  test.each([
    [
      "frozen model, caller messages fill the hole",
      "itx.openai.chat({ model: 'grok-4', messages: ?0 })",
      [["msg!"]],
      {},
      ["itx", "openai", ["chat", { model: "grok-4", messages: ["msg!"] }]],
      true,
    ],
    [
      "capture referenced on the target side (does NOT spend)",
      "itx.cd('/agents', ?name)",
      [],
      { name: "blah" },
      ["itx", ["cd", "/agents", "blah"]],
      false,
    ],
    ["bare rest = ALL the args", "itx.f(...?)", [1, 2, 3], {}, ["itx", ["f", 1, 2, 3]], true],
    [
      "explicit rest ...?1 = args.slice(1)",
      "itx.f(?0, ...?1)",
      [1, 2, 3],
      {},
      ["itx", ["f", 1, 2, 3]],
      true,
    ],
    [
      "hole-free target spends nothing",
      "itx.kv.get('a')",
      ["ignored"],
      {},
      ["itx", "kv", ["get", "a"]],
      false,
    ],
  ])("%s", (_label, target, args, captures, expectedSteps, expectedSpent) => {
    const { steps, spentArgs } = substitute(parse(target as string), {
      args: args as unknown[],
      captures: captures as Record<string, unknown>,
    });
    expect(steps).toEqual(expectedSteps);
    expect(spentArgs).toBe(expectedSpent);
  });

  test("bare ...? beside numeric holes is a LOUD error (explicit, never inferred)", () => {
    expect(() => substitute(parse("itx.f(?0, ...?)"), { args: [1, 2], captures: {} })).toThrow(
      /say \.\.\.\?n/,
    );
    // nested numeric holes count too — the shape the old inference got wrong
    expect(() =>
      substitute(parse("itx.f({ a: ?0 }, ...?)"), { args: [1, 2], captures: {} }),
    ).toThrow(/say \.\.\.\?n/);
  });

  test("spread-merge: FROZEN WINS on collision (and spends)", () => {
    const { steps, spentArgs } = substitute(parse("itx.openai.chat({ ...?, model: 'grok-4' })"), {
      args: [{ model: "evil", temperature: 0.5 }],
      captures: {},
    });
    const [, , chat] = steps as [string, string, [string, Record<string, unknown>]];
    expect(chat[1]).toEqual({ model: "grok-4", temperature: 0.5 });
    expect(spentArgs).toBe(true);
  });

  test("$ literal escape passes tagged-looking data through verbatim (and does NOT spend)", () => {
    const target: Expression = ["itx", ["f", { $: { "?": 0 } }]];
    const { steps, spentArgs } = substitute(target, { args: ["ignored"], captures: {} });
    expect(steps).toEqual(["itx", ["f", { "?": 0 }]]);
    expect(spentArgs).toBe(false);
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
    const result = await apply(s, substitute(target, { args: [], captures: m.captures }).steps, m);
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
    const result = await apply(s, target.steps, { ...m, boundaryArgs: undefined });
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
