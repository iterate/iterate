// context/itx-expression-rewriting.test.ts — THE TABLE: given these rewrite rules and this call, this
// is the call that runs. Every rule in itx-expression-rewriting.ts is a row here; read the rows, not
// the code. Rules are written `"match ⇒ target"`. Built-in roots for the table: kv, whoami, rpcStubs,
// load. Below the table: the ONE door (`rewriteRuleConfiguredEvent`), the resolver over a fake
// physical scope (built-ins first + unshadowable, default-deny, depth 32, lent stubs through a fake
// `itx.rpcStubs`), and the reduce as the DO runs it — the rules are `core` state, reduced from the log.
import { describe, expect, test } from "vitest";
import { CoreStreamProcessor, type ItxExpressionRewriteRule } from "../stream/core-processor.ts";
import type { StreamEvent } from "../stream/events.ts";
import { memoryStream } from "../stream/test-support.ts";
import { parse, parseItxExpressionPrefix, print, type ItxExpressionInput } from "./expression.ts";
import { InvokeHandle } from "./invoke-handle.ts";
import {
  ItxExpressionResolver,
  matchItxExpressionPrefix,
  rewriteItxExpressionToBuiltIn,
  rewriteRuleConfiguredEvent,
} from "./itx-expression-rewriting.ts";

const BUILT_IN_ROOTS = new Set(["kv", "whoami", "rpcStubs", "load"]);
const table = (rows: string[]): ItxExpressionRewriteRule[] =>
  rows.map((row) => {
    const [match, target] = row.split(" ⇒ ");
    return { match: parseItxExpressionPrefix(match), target: parse(target) };
  });
/** The call that runs, printed — or the refusal. */
const runs = (rules: string[], call: string): string => {
  try {
    return print(
      rewriteItxExpressionToBuiltIn(table(rules), parse(call), (root) => BUILT_IN_ROOTS.has(root)),
    );
  } catch (error) {
    return `THROWS ${(error as Error).message}`;
  }
};

describe("rewriteItxExpressionToBuiltIn — the call that runs", () => {
  const rows: { rules: string[]; call: string; becomes: string }[] = [
    // a built-in root needs no rule
    { rules: [], call: "itx.kv.get('k')", becomes: "itx.kv.get('k')" },
    // one rule: the match is replaced by the target, the rest of the call follows
    { rules: ["itx.db ⇒ itx.kv"], call: "itx.db.get('k')", becomes: "itx.kv.get('k')" },
    // rules compose by naming each other; a LONGER match under the target's prefix captures the deeper call
    {
      rules: ["itx.store ⇒ itx.kv", "itx.store.deep ⇒ itx.whoami", "itx.db ⇒ itx.store"],
      call: "itx.db.deep()",
      becomes: "itx.whoami()",
    },
    {
      rules: ["itx.store ⇒ itx.kv", "itx.store.deep ⇒ itx.whoami", "itx.db ⇒ itx.store"],
      call: "itx.db.get('k')",
      becomes: "itx.kv.get('k')",
    },
    // args at the match fold into the target's final NAME step
    { rules: ["itx.grok ⇒ itx.kv.get"], call: "itx.grok('k')", becomes: "itx.kv.get('k')" },
    // …and become an ANONYMOUS call when the target already ends in a call (a lent stub, root-called);
    // the canonical print form spells args without spaces
    {
      rules: ["itx.cam ⇒ itx.rpcStubs.get('itx.cam')"],
      call: "itx.cam(1,2)",
      becomes: "itx.rpcStubs.get('itx.cam')(1,2)",
    },
    {
      rules: ["itx.cam ⇒ itx.rpcStubs.get('itx.cam')"],
      call: "itx.cam.shot()",
      becomes: "itx.rpcStubs.get('itx.cam').shot()",
    },
    // the LONGEST match wins
    {
      rules: ["itx.a.b ⇒ itx.whoami", "itx.a ⇒ itx.kv"],
      call: "itx.a.b.f()",
      becomes: "itx.whoami.f()",
    },
    {
      rules: ["itx.a.b ⇒ itx.whoami", "itx.a ⇒ itx.kv"],
      call: "itx.a.c()",
      becomes: "itx.kv.c()",
    },
    // PINNED ARGS: `itx.ai.run('special')` beats `itx.ai.run`; the pinned arg is consumed
    {
      rules: ["itx.ai.run('special') ⇒ itx.whoami", "itx.ai.run ⇒ itx.kv.get"],
      call: "itx.ai.run('special')",
      becomes: "itx.whoami()",
    },
    {
      rules: ["itx.ai.run('special') ⇒ itx.whoami", "itx.ai.run ⇒ itx.kv.get"],
      call: "itx.ai.run('other')",
      becomes: "itx.kv.get('other')",
    },
    // unpinned trailing args are the call on the target (partial application)
    {
      rules: ["itx.ai.run('special') ⇒ itx.kv.get"],
      call: "itx.ai.run('special', 'k')",
      becomes: "itx.kv.get('k')",
    },
    // two pinned args outrank one
    {
      rules: ["itx.ai.run('m') ⇒ itx.kv.get", "itx.ai.run('m', 'fast') ⇒ itx.whoami"],
      call: "itx.ai.run('m', 'fast')",
      becomes: "itx.whoami()",
    },
    {
      rules: ["itx.ai.run('m') ⇒ itx.kv.get", "itx.ai.run('m', 'fast') ⇒ itx.whoami"],
      call: "itx.ai.run('m', 'slow')",
      becomes: "itx.kv.get('slow')",
    },
    // a MID-PREFIX pinned step is consumed too (the target replaces it)
    {
      rules: ["itx.repo.get('main').files ⇒ itx.kv.get"],
      call: "itx.repo.get('main').files('k')",
      becomes: "itx.kv.get('k')",
    },
    // structural equality: key order in a pinned object is irrelevant
    {
      rules: ["itx.ai.run({ a: 1, b: 2 }) ⇒ itx.whoami"],
      call: "itx.ai.run({ b: 2, a: 1 })",
      becomes: "itx.whoami()",
    },
  ];
  for (const { rules, call, becomes } of rows)
    test(`${call}  with  [${rules.join(" | ") || "no rules"}]  runs  ${becomes}`, () => {
      expect(runs(rules, call)).toBe(becomes);
    });

  const refusals: { rules: string[]; call: string; throws: RegExp }[] = [
    { rules: [], call: "itx.nope()", throws: /no rewrite rule matches "itx\.nope\(\)"/ },
    // a literal that differs and no plain rule beneath → nothing matches
    {
      rules: ["itx.ai.run('special') ⇒ itx.whoami"],
      call: "itx.ai.run('other')",
      throws: /no rewrite rule matches/,
    },
    // a residual arg on a NON-final pinned step has nowhere to go
    {
      rules: ["itx.repo.get('main').files ⇒ itx.kv.get"],
      call: "itx.repo.get('main', 'x').files('k')",
      throws: /no rewrite rule matches/,
    },
    // a property is not a call: the pinned rule does not claim `itx.ai.run`
    {
      rules: ["itx.ai.run('special') ⇒ itx.whoami"],
      call: "itx.ai.run",
      throws: /no rewrite rule matches/,
    },
    // a target not rooted at itx (a smuggled event) is denied whole — the built-ins are unreachable by name
    {
      rules: ["itx.evil ⇒ kv"],
      call: "itx.evil.get('a')",
      throws: /no rewrite rule matches "kv\.get/,
    },
    // a self-referential rule errors at the depth budget, never spins
    { rules: ["itx.loop ⇒ itx.loop"], call: "itx.loop.go()", throws: /depth 32/ },
  ];
  for (const { rules, call, throws } of refusals)
    test(`${call}  with  [${rules.join(" | ") || "no rules"}]  is refused: ${throws}`, () => {
      expect(runs(rules, call)).toMatch(throws);
    });

  test("the depth budget: a chain of 32 rules naming rules resolves, 33 trips", () => {
    const chain = (n: number) =>
      Array.from(
        { length: n },
        (_, i) => `itx.c${i} ⇒ ${i === 0 ? "itx.whoami" : `itx.c${i - 1}`}`,
      );
    expect(runs(chain(32), "itx.c31()")).toBe("itx.whoami()");
    expect(runs(chain(33), "itx.c32()")).toMatch(/depth 32/);
  });
});

describe("matchItxExpressionPrefix — one match against one call", () => {
  const rows: {
    match: string;
    call: string;
    claims: ReturnType<typeof matchItxExpressionPrefix>;
  }[] = [
    {
      match: "itx.a.b",
      call: "itx.a.b.c()",
      claims: { unpinnedArgs: undefined, stepsAfterMatch: [["c"]] },
    },
    { match: "itx.a.b", call: "itx.a.b(1)", claims: { unpinnedArgs: [1], stepsAfterMatch: [] } }, // a name's FINAL step may claim a call
    { match: "itx.a.b", call: "itx.a(1).b", claims: null }, // a call at a NON-final name step is not that name
    { match: "itx.a.b", call: "itx.a", claims: null }, // the match is longer than the call
    {
      match: "itx.ai.run('gpt-5')",
      call: "itx.ai.run('gpt-5', { n: 1 })",
      claims: { unpinnedArgs: [{ n: 1 }], stepsAfterMatch: [] },
    },
    { match: "itx.ai.run('gpt-5')", call: "itx.ai.run('other')", claims: null },
    { match: "itx.ai.run('gpt-5')", call: "itx.ai.run", claims: null },
    {
      match: "itx.repo.get('main').files",
      call: "itx.repo.get('main').files('k')",
      claims: { unpinnedArgs: ["k"], stepsAfterMatch: [] },
    },
    {
      match: "itx.repo.get('main').files",
      call: "itx.repo.get('main', 'x').files('k')",
      claims: null,
    },
  ];
  for (const { match, call, claims } of rows)
    test(`${match}  against  ${call}  →  ${claims ? `${print(claims.stepsAfterMatch) || "(nothing after)"}${claims.unpinnedArgs ? `, unpinned ${JSON.stringify(claims.unpinnedArgs)}` : ""}` : "no match"}`, () => {
      expect(matchItxExpressionPrefix(parseItxExpressionPrefix(match), parse(call))).toEqual(
        claims,
      );
    });
});

describe("the anonymous call step round-trips the codec", () => {
  test("`f(x)(y)` parses to an anonymous call and prints back; a prefix may not use it", () => {
    expect(parse("itx.rpcStubs.get('cam')(1,2)")).toEqual([
      "itx",
      "rpcStubs",
      ["get", "cam"],
      ["", 1, 2],
    ]);
    expect(print(["itx", "rpcStubs", ["get", "cam"], ["", 1, 2]])).toBe(
      "itx.rpcStubs.get('cam')(1,2)",
    );
    expect(() => parseItxExpressionPrefix("itx.a.b('x')(1)")).toThrow(/cannot call a result/);
  });
});

// ───────────────────────────── the door ─────────────────────────────

describe("rewriteRuleConfiguredEvent — ONE event, both halves canonical, loud at the door", () => {
  test("STRING AT REST: the event stores both halves as strings — the target print-canonicalized, human-readable in the log", () => {
    expect(rewriteRuleConfiguredEvent("itx.db", ["itx", "facets", ["get", "tab-1"]])).toEqual({
      type: "events.iterate.com/itx/rewrite-rule-configured",
      payload: { match: "itx.db", target: "itx.facets.get('tab-1')" },
    });
    // either codec half on either side
    expect(rewriteRuleConfiguredEvent(["itx", "db"], "itx.facets.get('tab-1')").payload).toEqual({
      match: "itx.db",
      target: "itx.facets.get('tab-1')",
    });
  });

  test("`null` target is the un-set: the same event, target null", () => {
    expect(rewriteRuleConfiguredEvent("itx.db", null)).toEqual({
      type: "events.iterate.com/itx/rewrite-rule-configured",
      payload: { match: "itx.db", target: null },
    });
  });

  test("the target must be rooted at itx (a bare built-in root is unspellable)", () => {
    expect(() => rewriteRuleConfiguredEvent("itx.evil", "kv")).toThrow(/must be rooted at "itx"/);
    expect(() => rewriteRuleConfiguredEvent("itx.x", ["kv", "get"])).toThrow(
      /must be rooted at "itx"/,
    );
  });

  test("the match may PIN literal args on a call step (stored canonical); an argless call step, an anonymous step and an unbalanced paren are refused", () => {
    expect(
      (rewriteRuleConfiguredEvent("itx.ai.run('gpt-5')", "itx.kv").payload as { match: string })
        .match,
    ).toBe("itx.ai.run('gpt-5')");
    expect(() => rewriteRuleConfiguredEvent("itx.a()", "itx.kv")).toThrow(
      /pins literal args.*spell "a"/,
    );
    expect(() => rewriteRuleConfiguredEvent("itx.a('x')(1)", "itx.kv")).toThrow(
      /cannot call a result/,
    );
    expect(() => rewriteRuleConfiguredEvent("itx.broken(", "itx.kv")).toThrow(/unbalanced/);
  });
});

// ───────────────────────────── the resolver, over the reduce as the DO runs it ─────────────────────────────

/** A tiny fake built-ins record — enough physical layer to rewrite into. */
const fakeBuiltIns = () => {
  const kv = new Map<string, string>();
  const openaiCalls: unknown[] = [];
  return {
    kv: {
      get: (k: string) => kv.get(k) ?? null,
      put: (k: string, v: string) => {
        kv.set(k, v);
        return { ok: true };
      },
    },
    whoami: () => ({ projectId: "prj_t", path: "/" }),
    openai: {
      chat: (o: { model: string }) => {
        openaiCalls.push(o);
        return `chat:${o.model}`;
      },
    },
    openaiCalls,
  };
};

const setup = () => {
  const { stream, events } = memoryStream();
  const core = new CoreStreamProcessor();
  const builtIns = fakeBuiltIns();
  // INLINE, exactly like the DO: the rules are core state, reduced from the durable log per call —
  // and, as in Stream.#reduceEventIntoCoreReducedState, a malformed control event is skipped
  // (reported), never wedging the stream.
  const rewriteRules = (): ItxExpressionRewriteRule[] =>
    Object.values(
      events.reduce((st, e) => {
        try {
          return core.reduce({ event: e, state: st }) ?? st;
        } catch {
          return st;
        }
      }, core.contract.initialState()).itxExpressionRewriteRules,
    );
  // The fake `itx.rpcStubs` BUILT-IN — the physical registry behind a lent stub, keyed by the opaque
  // rpcStubKey, exactly like the DO's RpcStubDirectory. _lend/_recall simulate a lend / a final
  // recall. A rule names an entry through the pure-data target `itx.rpcStubs.get('<key>')`; nothing
  // about the registry is in the log.
  const lentRpcStubs = new Map<string, unknown>();
  const rpcStubs = {
    get: (rpcStubKey: string) =>
      new InvokeHandle((itxExpressionSteps) => {
        let value = lentRpcStubs.get(rpcStubKey) as
          | Record<string, unknown>
          | ((...a: unknown[]) => unknown);
        if (value === undefined) throw new Error(`rpc stub "${rpcStubKey}" is offline`);
        let receiver: unknown = undefined;
        for (const step of itxExpressionSteps) {
          if (typeof step === "string") {
            receiver = value;
            value = (value as Record<string, unknown>)[step] as typeof value;
          } else {
            const [method, ...args] = step;
            const fn = method === "" ? value : (value as Record<string, unknown>)[method];
            value = (fn as (...a: unknown[]) => unknown).apply(
              method === "" ? receiver : value,
              args,
            ) as typeof value;
            receiver = undefined;
          }
        }
        return value;
      }),
    list: () => [...lentRpcStubs.keys()],
  };
  const resolver = new ItxExpressionResolver({ builtIns: { ...builtIns, rpcStubs }, rewriteRules });
  /** The edge's `rewrite(match, target)`: build the ONE event, append it. A refusal throws at the
   *  door — nothing is appended. */
  const rewrite = (match: ItxExpressionInput, target: ItxExpressionInput | null) =>
    (stream.append(rewriteRuleConfiguredEvent(match, target)) as StreamEvent[])[0];
  /** The edge's `provide(key, { stub, rewrite })`, spelled out: lend under the key, configure the
   *  pure-data rule. */
  const provide = (rpcStubKey: string, stub: unknown) => {
    lentRpcStubs.set(rpcStubKey, stub);
    return rewrite(rpcStubKey, `itx.rpcStubs.get('${rpcStubKey}')`);
  };
  return {
    stream,
    events,
    builtIns,
    rewriteRules,
    invoke: (call: ItxExpressionInput) => resolver.resolve(call),
    rewrite,
    provide,
    _lend: (rpcStubKey: string, stub: unknown) => lentRpcStubs.set(rpcStubKey, stub),
    _recall: (rpcStubKey: string) => lentRpcStubs.delete(rpcStubKey),
  };
};

describe("built-in resolution + default-deny", () => {
  test("built-ins resolve directly (no rule, no config)", async () => {
    const { invoke } = setup();
    expect(await invoke("itx.whoami()")).toEqual({ projectId: "prj_t", path: "/" });
    expect(await invoke("itx.kv.put('a', '1')")).toEqual({ ok: true });
    expect(await invoke("itx.kv.get('a')")).toBe("1");
  });

  test("default-deny: no match is a readable, CODED error", async () => {
    const { invoke } = setup();
    await expect(invoke("itx.nope.thing()")).rejects.toMatchObject({
      code: "NO_ITX_EXPRESSION_MATCH",
      message: expect.stringMatching(/no rewrite rule matches.*itx\.nope\.thing/),
    });
  });

  test("even a smuggled raw event cannot reach the built-ins (a target not rooted at itx matches nothing — default-deny)", async () => {
    const { stream, invoke } = setup();
    // bypass the door entirely — append the raw string-at-rest event
    stream.append({
      type: "events.iterate.com/itx/rewrite-rule-configured",
      payload: { match: "itx.evil", target: "kv" },
    });
    // the rewritten call `kv.get('a')` is denied whole — nothing not rooted at itx ever matches
    await expect(invoke("itx.evil.get('a')")).rejects.toThrow(/no rewrite rule matches "kv\.get/);
  });

  test("a malformed raw payload is skipped by the reduce, never wedging later resolves", async () => {
    const { stream, invoke } = setup();
    stream.append({
      type: "events.iterate.com/itx/rewrite-rule-configured",
      payload: { match: "itx.broken(", target: "itx.kv" },
    });
    // the table still answers — the bad rule simply doesn't exist
    expect(await invoke("itx.whoami()")).toEqual({ projectId: "prj_t", path: "/" });
    await expect(invoke("itx.broken.x()")).rejects.toThrow(/no rewrite rule matches/);
  });

  test("a hand-built call step at the scope root is denied like any other non-match", async () => {
    const { invoke } = setup();
    await expect(invoke([["itx", 1]])).rejects.toThrow(/no rewrite rule matches "itx\(1\)"/);
  });
});

describe("the rule table — a MAP by match: set replaces, null deletes", () => {
  test("⚠️ a self-referential rule errors at depth, never spins", async () => {
    const { rewrite, invoke } = setup();
    rewrite("itx.loop", "itx.loop");
    await expect(invoke("itx.loop.go()")).rejects.toThrow(/depth 32/);
  });

  test("a rule targeting another rule: the target rewrites one level deeper, the steps after the match replay on it", async () => {
    const { rewrite, invoke } = setup();
    rewrite("itx.db", "itx.kv");
    await invoke("itx.db.put('k', 'v')");
    expect(await invoke("itx.kv.get('k')")).toBe("v"); // same underlying kv — the rules composed
  });

  test("a longer match under the target's prefix CAPTURES the deeper call — a rule rewrites the call, it does not bind a value", async () => {
    const { rewrite, invoke } = setup();
    rewrite("itx.store", "itx.kv");
    rewrite("itx.store.deep", "itx.whoami"); // longer than `itx.store`: wins for `.deep`
    rewrite("itx.db", "itx.store");
    // `itx.db.deep()` rewrites to `itx.store.deep()`, which the longer match claims — never a walk on
    // the kv value's (non-existent) `deep`. (A BUILT-IN root stays unshadowable: a rule under
    // `itx.kv.…` is never consulted, because `itx.kv…` resolves against the physical scope first.)
    expect(await invoke("itx.db.deep()")).toEqual(await invoke("itx.whoami()"));
    expect(await invoke("itx.db.get('missing')")).toBeNull(); // the shorter match still reaches kv
  });

  test("a provided stub is an ordinary rule whose target names the registry — pure data, nothing about the socket", () => {
    const { events, provide } = setup();
    provide("itx.cam", { shot: () => "frame" });
    expect(events.at(-1)!.payload).toEqual({
      match: "itx.cam",
      target: "itx.rpcStubs.get('itx.cam')",
    });
  });

  test("LONGEST MATCH WINS at resolve: a deeper rule takes the calls under it, the shorter keeps the rest", async () => {
    const { provide, rewrite, invoke } = setup();
    provide("itx.wide", { f: () => "wide", deep: { f: () => "wide's deep" } });
    provide("itx.narrow", { f: () => "narrow" });
    rewrite("itx.a", "itx.wide");
    rewrite("itx.a.deep", "itx.narrow");
    expect(await invoke("itx.a.deep.f()")).toBe("narrow");
    expect(await invoke("itx.a.f()")).toBe("wide");
  });

  test("a re-set REPLACES the rule at that match; `null` DELETES it; setting the old target back restores it (no stack)", async () => {
    const { rewrite, invoke, provide, rewriteRules } = setup();
    provide("itx.tab1", { hello: () => "from tab-1" });
    provide("itx.tab2", { hello: () => "from tab-2" });
    rewrite("itx.greeter", "itx.tab1");
    rewrite("itx.greeter", "itx.tab2");
    expect(await invoke("itx.greeter.hello()")).toBe("from tab-2"); // replaced
    expect(rewriteRules().filter((rule) => print(rule.match) === "itx.greeter")).toHaveLength(1);
    rewrite("itx.greeter", null);
    await expect(invoke("itx.greeter.hello()")).rejects.toThrow(/no rewrite rule matches/); // gone, nothing beneath
    rewrite("itx.greeter", "itx.tab1");
    expect(await invoke("itx.greeter.hello()")).toBe("from tab-1"); // restored by setting it back
  });

  test("the rule is data, the stub is physical: re-lending serves the same rule, the log is untouched; un-setting the rule → default-deny while presence stays", async () => {
    const { rewrite, invoke, events, provide, _lend, _recall } = setup();
    provide("itx.cam", { shot: () => "frame 1" });
    const logLength = events.length;
    // The provider drops and comes back: the registry entry is replaced, the log is untouched.
    _recall("itx.cam");
    await expect(invoke("itx.cam.shot()")).rejects.toThrow(/offline/);
    _lend("itx.cam", { shot: () => "frame 2" });
    expect(await invoke("itx.cam.shot()")).toBe("frame 2");
    expect(events).toHaveLength(logLength);
    rewrite("itx.cam", null);
    await expect(invoke("itx.cam.shot()")).rejects.toThrow(/no rewrite rule matches/);
    expect(await invoke("itx.rpcStubs.list()")).toEqual(["itx.cam"]); // presence is physical
  });

  test("args at the match: a call at the match itself applies the rewritten target", async () => {
    const { rewrite, invoke, builtIns } = setup();
    rewrite("itx.grok", "itx.openai.chat");
    expect(await invoke("itx.grok({ model: 'grok-4' })")).toBe("chat:grok-4");
    expect(builtIns.openaiCalls[0]).toEqual({ model: "grok-4" });
  });

  test("default route: a lent stub at bare `itx` catches whole missed calls (ancestry with zero machinery)", async () => {
    const { invoke, provide } = setup();
    const osCalls: string[] = [];
    provide("itx", {
      anything: (...a: unknown[]) => {
        osCalls.push(`anything(${a.join(",")})`);
        return "handled upstream";
      },
    });
    expect(await invoke("itx.anything('x')")).toBe("handled upstream");
    expect(osCalls).toEqual(["anything(x)"]);
    // built-ins still resolve BEFORE the default route (built-in-first, unshadowable)
    expect(await invoke("itx.whoami()")).toEqual({ projectId: "prj_t", path: "/" });
  });

  test("a rule to a key nothing is lent under answers offline until the rule is un-set — the table never auto-unsets", async () => {
    const { rewrite, invoke, rewriteRules, provide, _recall } = setup();
    provide("itx.robot", { move: (n: unknown) => `moved ${n}` });
    expect(await invoke("itx.robot.move(10)")).toBe("moved 10");
    _recall("itx.robot");
    await expect(invoke("itx.robot.move(10)")).rejects.toThrow(/offline/);
    expect(rewriteRules().some((rule) => print(rule.match) === "itx.robot")).toBe(true);
    rewrite("itx.robot", null);
    await expect(invoke("itx.robot.move(10)")).rejects.toThrow(/no rewrite rule matches/);
  });

  test("un-setting a match with no rule, or a built-in root's name, is a no-op — the table still resolves", async () => {
    const { rewrite, invoke, events } = setup();
    rewrite("itx.never", null);
    rewrite("itx.kv", null); // built-ins are not rules; nothing to delete
    expect(events).toHaveLength(2); // the events land; the reduce keeps the state
    expect(await invoke("itx.kv.put('a', '1')")).toEqual({ ok: true });
    expect(await invoke("itx.kv.get('a')")).toBe("1");
  });
});

describe("targets round-trip the codec: rewrite → print → reduce → parse", () => {
  test("a target with a large number literal rewrites (print renders 1e21 as 1e+21; the parser reads the exponent)", async () => {
    const { rewrite, invoke, provide } = setup();
    provide("itx.c", { echo: (n: unknown) => `echo:${n}` });
    rewrite("itx.big", ["itx", "c", ["echo", 1e21]]);
    expect(await invoke("itx.big")).toBe(`echo:${1e21}`); // the target is a complete call
  });

  test("a target with a non-identifier object key rewrites (print QUOTES the key; the parser re-reads it)", async () => {
    const { rewrite, invoke } = setup();
    rewrite("itx.chat", ["itx", "openai", ["chat", { "a b": "grok-4" }]]);
    // openai.chat reads o.model (absent here) → "chat:undefined"; the point is it REWRITES at all.
    expect(await invoke("itx.chat")).toBe("chat:undefined");
  });
});
