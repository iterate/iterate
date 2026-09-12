// context/itx-expression-rewriting.test.ts — THE TABLE: given these rewrite rules and this call, this
// is the call that runs. Every rule in itx-expression-rewriting.ts is a row here; read the rows, not
// the code. Rules are written `"match ⇒ target"`; `null` is a MASK. Built-in roots for the table: kv,
// whoami, rpcStubs, ai — reached as `itx.builtins.<root>` (the fixed point) or through the implicit
// platform row `itx.<root> ⇒ itx.builtins.<root>`. Below the table: the ONE door
// (`normalizeRewriteRuleConfigured` + `restoreRuleTarget`), the resolver over a fake physical scope
// (rules first, masks, the fixed point, default-deny, depth 32, lent stubs through a fake
// `itx.builtins.rpcStubs`), and the reduce as the DO runs it — the rules are `core` state, reduced
// from the log.
import { describe, expect, test } from "vitest";
import { CoreContract, normalizeControlEvent, reduceCoreEvent } from "../stream/core-processor.ts";
import type { StreamEvent } from "../stream/processor.ts";
import { memoryStream } from "../stream/test-support.ts";
import {
  parse,
  parseItxExpressionPrefix,
  print,
  type ItxExpressionInput,
  InvokeHandle,
} from "./expression.ts";
import {
  ItxExpressionResolver,
  type ItxExpressionRewriteRule,
  matchItxExpressionPrefix,
  resolveItxExpression,
  restoreRuleTarget,
  rowsNamingRpcStub,
} from "./itx-expression-rewriting.ts";

const table = (rows: string[]): ItxExpressionRewriteRule[] =>
  rows.map((row) => {
    const [match, target] = row.split(" ⇒ ");
    return {
      match: parseItxExpressionPrefix(match),
      target: target === "null" ? null : parse(target, { holes: true }), // a target may hold `@`
    };
  });
/** The chain of rewrites, printed — or the refusal. */
const chain = (rules: string[], call: string): string[] | string => {
  try {
    return resolveItxExpression(() => table(rules), parse(call)).map((step) => print(step));
  } catch (error) {
    return `THROWS ${(error as Error).message}`;
  }
};
/** The call that runs (the chain's last element), printed — or the refusal. */
const runs = (rules: string[], call: string): string => {
  const c = chain(rules, call);
  return typeof c === "string" ? c : c.at(-1)!;
};

describe("resolveItxExpression — the call that runs", () => {
  const rows: { rules: string[]; call: string; becomes: string }[] = [
    // a built-in root needs no rule: THE IMPLICIT PLATFORM ROW `itx.kv ⇒ itx.builtins.kv`
    { rules: [], call: "itx.kv.get('k')", becomes: "itx.builtins.kv.get('k')" },
    // the reserved root is the FIXED POINT: a builtins-rooted call runs as is
    { rules: [], call: "itx.builtins.kv.get('k')", becomes: "itx.builtins.kv.get('k')" },
    // one rule: the match is replaced by the target, the rest of the call follows
    { rules: ["itx.db ⇒ itx.kv"], call: "itx.db.get('k')", becomes: "itx.builtins.kv.get('k')" },
    // RULES FIRST: a row at a built-in's name SHADOWS the platform row (Misha's fake `itx.ai`)
    {
      rules: ["itx.kv ⇒ itx.whoami"],
      call: "itx.kv.get('k')",
      becomes: "itx.builtins.whoami.get('k')",
    },
    // …a LONGER row under a built-in root captures only the calls it claims
    {
      rules: ["itx.kv.get ⇒ itx.whoami"],
      call: "itx.kv.get('k')",
      becomes: "itx.builtins.whoami('k')",
    },
    {
      rules: ["itx.kv.get ⇒ itx.whoami"],
      call: "itx.kv.put('k', 'v')",
      becomes: "itx.builtins.kv.put('k','v')",
    },
    // …and the physical spelling is never shadowed
    {
      rules: ["itx.kv ⇒ itx.whoami"],
      call: "itx.builtins.kv.get('k')",
      becomes: "itx.builtins.kv.get('k')",
    },
    // THE WHOLE-CONTEXT OVERRIDE: a bare `itx` row claims every short-named call (its target must be
    // the physical spelling — a short target would be its own next match; see the refusals)
    {
      rules: ["itx ⇒ itx.builtins.rpcStubs.get('itx')"],
      call: "itx.append({ type: 't' })",
      becomes: "itx.builtins.rpcStubs.get('itx').append({type:'t'})",
    },
    {
      rules: ["itx ⇒ itx.builtins.rpcStubs.get('itx')"],
      call: "itx.builtins.append({ type: 't' })",
      becomes: "itx.builtins.append({type:'t'})",
    },
    // rules compose by naming each other; a LONGER match under the target's prefix captures the deeper call
    {
      rules: ["itx.store ⇒ itx.kv", "itx.store.deep ⇒ itx.whoami", "itx.db ⇒ itx.store"],
      call: "itx.db.deep()",
      becomes: "itx.builtins.whoami()",
    },
    {
      rules: ["itx.store ⇒ itx.kv", "itx.store.deep ⇒ itx.whoami", "itx.db ⇒ itx.store"],
      call: "itx.db.get('k')",
      becomes: "itx.builtins.kv.get('k')",
    },
    // args at the match fold into the target's final NAME step
    {
      rules: ["itx.grok ⇒ itx.kv.get"],
      call: "itx.grok('k')",
      becomes: "itx.builtins.kv.get('k')",
    },
    // …and become an ANONYMOUS call when the target already ends in a call (a lent stub, root-called);
    // the canonical print form spells args without spaces. The target denotes a VALUE.
    {
      rules: ["itx.cam ⇒ itx.rpcStubs.get('itx.cam')"],
      call: "itx.cam(1,2)",
      becomes: "itx.builtins.rpcStubs.get('itx.cam')(1,2)",
    },
    {
      rules: ["itx.cam ⇒ itx.builtins.rpcStubs.get('itx.cam')"],
      call: "itx.cam.shot()",
      becomes: "itx.builtins.rpcStubs.get('itx.cam').shot()",
    },
    // the LONGEST match wins
    {
      rules: ["itx.a.b ⇒ itx.whoami", "itx.a ⇒ itx.kv"],
      call: "itx.a.b.f()",
      becomes: "itx.builtins.whoami.f()",
    },
    {
      rules: ["itx.a.b ⇒ itx.whoami", "itx.a ⇒ itx.kv"],
      call: "itx.a.c()",
      becomes: "itx.builtins.kv.c()",
    },
    // PINNED ARGS: `itx.ai.run('special')` beats `itx.ai.run`; the pinned arg is consumed
    {
      rules: ["itx.ai.run('special') ⇒ itx.whoami", "itx.ai.run ⇒ itx.kv.get"],
      call: "itx.ai.run('special')",
      becomes: "itx.builtins.whoami()",
    },
    {
      rules: ["itx.ai.run('special') ⇒ itx.whoami", "itx.ai.run ⇒ itx.kv.get"],
      call: "itx.ai.run('other')",
      becomes: "itx.builtins.kv.get('other')",
    },
    // unpinned trailing args are the call on the target (partial application)
    {
      rules: ["itx.ai.run('special') ⇒ itx.kv.get"],
      call: "itx.ai.run('special', 'k')",
      becomes: "itx.builtins.kv.get('k')",
    },
    // two pinned args outrank one
    {
      rules: ["itx.ai.run('m') ⇒ itx.kv.get", "itx.ai.run('m', 'fast') ⇒ itx.whoami"],
      call: "itx.ai.run('m', 'fast')",
      becomes: "itx.builtins.whoami()",
    },
    {
      rules: ["itx.ai.run('m') ⇒ itx.kv.get", "itx.ai.run('m', 'fast') ⇒ itx.whoami"],
      call: "itx.ai.run('m', 'slow')",
      becomes: "itx.builtins.kv.get('slow')",
    },
    // a MID-PREFIX pinned step is consumed too (the target replaces it)
    {
      rules: ["itx.repo.get('main').files ⇒ itx.kv.get"],
      call: "itx.repo.get('main').files('k')",
      becomes: "itx.builtins.kv.get('k')",
    },
    // structural equality: key order in a pinned object is irrelevant
    {
      rules: ["itx.ai.run({ a: 1, b: 2 }) ⇒ itx.whoami"],
      call: "itx.ai.run({ b: 2, a: 1 })",
      becomes: "itx.builtins.whoami()",
    },
    // RULE 7 — `@` IS THE CALLER'S INPUT: the target is a TEMPLATE, rule 4's fold does not apply.
    // As a top-level argument `@` is the unpinned args, SPLICED — the real Workers AI shape,
    // `run(model, inputs, options?)`, with the model pinned (THE DREAM: `itx.fable(inputs)`)
    {
      rules: ["itx.fable ⇒ itx.ai.run('@cf/meta/llama-3.2-1b-instruct', @)"],
      call: "itx.fable({ prompt: 'hi' })",
      becomes: "itx.builtins.ai.run('@cf/meta/llama-3.2-1b-instruct',{prompt:'hi'})",
    },
    {
      rules: ["itx.fable ⇒ itx.ai.run('@cf/meta/llama-3.2-1b-instruct', @)"],
      call: "itx.fable({ prompt: 'hi' }, { gateway: { id: 'g' } })",
      becomes:
        "itx.builtins.ai.run('@cf/meta/llama-3.2-1b-instruct',{prompt:'hi'},{gateway:{id:'g'}})",
    },
    // …a property access on the match has no args: `@` DROPS (and the steps after the match follow)
    {
      rules: ["itx.fable ⇒ itx.ai.run('@cf/meta/llama-3.2-1b-instruct', @)"],
      call: "itx.fable",
      becomes: "itx.builtins.ai.run('@cf/meta/llama-3.2-1b-instruct')",
    },
    {
      rules: ["itx.fable ⇒ itx.ai.run('m', @)"],
      call: "itx.fable.then",
      becomes: "itx.builtins.ai.run('m').then",
    },
    // …only a BARE `@` is the marker: `'@cf/…'`, `'a@b.c'` inside quotes are strings like any other
    {
      rules: ["itx.mail ⇒ itx.kv.get('a@b.c', @)"],
      call: "itx.mail('x@y')",
      becomes: "itx.builtins.kv.get('a@b.c','x@y')",
    },
    // …a lent stub's method called with args through `@` (the registry is the fixed point)
    {
      rules: ["itx.snap ⇒ itx.builtins.rpcStubs.get('cam').shot('wide', @)"],
      call: "itx.snap(1, 2)",
      becomes: "itx.builtins.rpcStubs.get('cam').shot('wide',1,2)",
    },
    // …NESTED inside a literal `@` is THE one argument
    {
      rules: ["itx.ask ⇒ itx.ai.gateway('g').run({ provider: 'workers-ai', query: @ })"],
      call: "itx.ask({ prompt: 'hi' })",
      becomes: "itx.builtins.ai.gateway('g').run({provider:'workers-ai',query:{prompt:'hi'}})",
    },
    // …`...@` merges the one argument's fields under the template's own keys — a frontier model through
    // the gateway with the model PINNED: the template's `model` WINS over the caller's
    {
      rules: [
        "itx.claude ⇒ itx.ai.gateway('g').run({ provider: 'anthropic', endpoint: 'v1/messages', query: { model: 'claude-x', ...@ } })",
      ],
      call: "itx.claude({ messages: [{ role: 'user', content: 'hi' }], model: 'evil' })",
      becomes:
        "itx.builtins.ai.gateway('g').run({endpoint:'v1/messages',provider:'anthropic',query:{messages:[{content:'hi',role:'user'}],model:'claude-x'}})",
    },
  ];
  for (const { rules, call, becomes } of rows)
    test(`${call}  with  [${rules.join(" | ") || "no rules"}]  runs  ${becomes}`, () => {
      expect(runs(rules, call)).toBe(becomes);
    });

  const refusals: { rules: string[]; call: string; throws: RegExp }[] = [
    { rules: [], call: "itx.nope()", throws: /no rewrite rule matches "itx\.nope\(\)"/ },
    // a MASK: `null` at a built-in's name refuses the call even though the platform row lies beneath
    {
      rules: ["itx.kv ⇒ null"],
      call: "itx.kv.get('k')",
      throws: /"itx\.kv\.get\('k'\)" is masked/,
    },
    // …a partial mask refuses only what it claims (the sibling call runs — see the rows above)
    { rules: ["itx.kv.get ⇒ null"], call: "itx.kv.get('k')", throws: /is masked/ },
    // …a bare `itx` mask denies every short-named call
    { rules: ["itx ⇒ null"], call: "itx.whoami()", throws: /is masked/ },
    // …a mask reached THROUGH another rule still refuses (rules first, at every step)
    { rules: ["itx.db ⇒ itx.kv", "itx.kv ⇒ null"], call: "itx.db.get('k')", throws: /is masked/ },
    // a literal that differs and no plain rule beneath → nothing matches (`llm` is no root; `itx.ai`
    // would fall to its platform row — see the pinned-args rows above)
    {
      rules: ["itx.llm.run('special') ⇒ itx.whoami"],
      call: "itx.llm.run('other')",
      throws: /no rewrite rule matches/,
    },
    // a residual arg on a NON-final pinned step has nowhere to go
    {
      rules: ["itx.repo.get('main').files ⇒ itx.kv.get"],
      call: "itx.repo.get('main', 'x').files('k')",
      throws: /no rewrite rule matches/,
    },
    // a property is not a call: the pinned rule does not claim `itx.llm.run`
    {
      rules: ["itx.llm.run('special') ⇒ itx.whoami"],
      call: "itx.llm.run",
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
    // …and so does a bare `itx` row with a SHORT target: the row claims its own target (the proxy
    // always writes the physical spelling for exactly this reason)
    { rules: ["itx ⇒ itx.rpcStubs.get('itx')"], call: "itx.append(1)", throws: /depth 32/ },
    // RULE 7 refusals: a nested `@` or a `...@` needs EXACTLY one argument — never a guess
    {
      rules: ["itx.ask ⇒ itx.ai.gateway('g').run({ query: @ })"],
      call: "itx.ask(1, 2)",
      throws: /a nested `@` in the target .* takes exactly one argument, got 2/,
    },
    {
      rules: ["itx.ask ⇒ itx.ai.gateway('g').run({ query: @ })"],
      call: "itx.ask",
      throws: /takes exactly one argument, got 0/,
    },
    {
      rules: ["itx.claude ⇒ itx.ai.run({ query: { ...@ } })"],
      call: "itx.claude({}, {})",
      throws: /`\.\.\.@` in the target .* takes exactly one argument, got 2/,
    },
    {
      rules: ["itx.claude ⇒ itx.ai.run({ query: { ...@ } })"],
      call: "itx.claude('not an object')",
      throws: /merges an object; the argument is "not an object"/,
    },
  ];
  for (const { rules, call, throws } of refusals)
    test(`${call}  with  [${rules.join(" | ") || "no rules"}]  is refused: ${throws}`, () => {
      expect(runs(rules, call)).toMatch(throws);
    });

  test("the depth budget: 32 REWRITES resolve (31 rules + the platform row), 33 trip", () => {
    const chainOf = (n: number) =>
      Array.from(
        { length: n },
        (_, i) => `itx.c${i} ⇒ ${i === 0 ? "itx.whoami" : `itx.c${i - 1}`}`,
      );
    expect(runs(chainOf(31), "itx.c30()")).toBe("itx.builtins.whoami()"); // 31 rules + the platform row = 32
    expect(runs(chainOf(32), "itx.c31()")).toMatch(/depth 32/);
  });

  test("THE CHAIN: every rewrite in order, the call itself first, the builtins-rooted call last", () => {
    expect(
      chain(
        ["itx.greeter ⇒ itx.greeterA", "itx.greeterA ⇒ itx.rpcStubs.get('a')"],
        "itx.greeter.hello()",
      ),
    ).toEqual([
      "itx.greeter.hello()",
      "itx.greeterA.hello()",
      "itx.rpcStubs.get('a').hello()",
      "itx.builtins.rpcStubs.get('a').hello()",
    ]);
    expect(chain([], "itx.builtins.kv.get('k')")).toEqual(["itx.builtins.kv.get('k')"]); // already there
  });

  test("a builtins-rooted call NEVER reads the table (the fixed point is checked before the rules)", () => {
    const neverRead = () => {
      throw new Error("the table was read");
    };
    expect(print(resolveItxExpression(neverRead, parse("itx.builtins.kv.get('k')")).at(-1)!)).toBe(
      "itx.builtins.kv.get('k')",
    );
    // …while a short name does (and the read happens once)
    expect(() => resolveItxExpression(neverRead, parse("itx.kv.get('k')"))).toThrow(
      /the table was read/,
    );
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
    // the bare root claims every call (the whole-context override)
    {
      match: "itx",
      call: "itx.append(1)",
      claims: { unpinnedArgs: undefined, stepsAfterMatch: [["append", 1]] },
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

describe("`@` round-trips the codec (targets only): parse → print → parse; the one reserved literal", () => {
  test("`@` and `...@` lex to the marker literals and print back; nothing inside quotes is touched", () => {
    const target =
      "itx.ai.gateway('g').run({ provider: 'anthropic', query: { model: 'claude-x', ...@ } }, @, [@], 'a@b')";
    const parsed = parse(target, { holes: true });
    expect(parsed).toEqual([
      "itx",
      "ai",
      ["gateway", "g"],
      [
        "run",
        { provider: "anthropic", query: { model: "claude-x", "...@": true } },
        { "@": true },
        [{ "@": true }],
        "a@b",
      ],
    ]);
    expect(print(parsed, { holes: true })).toBe(
      "itx.ai.gateway('g').run({provider:'anthropic',query:{...@,model:'claude-x'}},@,[@],'a@b')",
    );
    expect(parse(print(parsed, { holes: true }), { holes: true })).toEqual(parsed);
    // without `holes` the reserved literals print as the plain JSON5 they are — a CALL that carries
    // `{ "@": true }` as data round-trips through `parse` (no holes) unchanged
    expect(print(parsed)).toBe(
      "itx.ai.gateway('g').run({provider:'anthropic',query:{'...@':true,model:'claude-x'}},{'@':true},[{'@':true}],'a@b')",
    );
    expect(parse(print(["itx", ["x", { "@": true }, { "...@": true }]]))).toEqual([
      "itx",
      ["x", { "@": true }, { "...@": true }],
    ]);
    // a string VALUE that spells the marker's printed form is a string — print skips string literals
    expect(print(["itx", "kv", ["put", "k", "{'@':true}"]], { holes: true })).toBe(
      `itx.kv.put('k',"{'@':true}")`,
    );
    expect(parse(`itx.kv.put('k',"{'@':true}")`)).toEqual([
      "itx",
      "kv",
      ["put", "k", "{'@':true}"],
    ]);
  });

  test("a bare `@` in a CALL (or any parse without `holes`) is refused in the marker's own words", () => {
    expect(() => parse("itx.kv.get(@)")).toThrow(/legal only in a rewrite rule's target/);
    expect(() => parse("itx.ai.run({ q: ...@ })")).toThrow(/legal only in a rewrite rule's target/);
    expect(parse("itx.kv.get('a@b', \"x@y\")")).toEqual(["itx", "kv", ["get", "a@b", "x@y"]]);
  });
});

// ───────────────────────────── the door ─────────────────────────────

describe("rewrite-rule-configured — ONE event, both halves canonical, loud at the append boundary", () => {
  test("AT REST: BOTH halves are the PARSED form (either codec half in, the parsed form out) — the reduce keys the table by printing the match, so a canonical match over the codec cap never re-parses", () => {
    expect(
      normalizeControlEvent({
        type: "events.iterate.com/itx/rewrite-rule-configured",
        payload: { match: "itx.db", target: ["itx", "facets", ["get", "tab-1"]] },
      }),
    ).toEqual({
      type: "events.iterate.com/itx/rewrite-rule-configured",
      payload: { match: ["itx", "db"], target: ["itx", "facets", ["get", "tab-1"]] },
    });
    // either codec half on either side, parsed once at the door
    expect(
      normalizeControlEvent({
        type: "events.iterate.com/itx/rewrite-rule-configured",
        payload: { match: ["itx", "db"], target: "itx.facets.get('tab-1')" },
      }).payload,
    ).toEqual({
      match: ["itx", "db"],
      target: ["itx", "facets", ["get", "tab-1"]],
    });
  });

  test("`null` target is the deny: the same event, target null", () => {
    expect(
      normalizeControlEvent({
        type: "events.iterate.com/itx/rewrite-rule-configured",
        payload: { match: "itx.db", target: null },
      }),
    ).toEqual({
      type: "events.iterate.com/itx/rewrite-rule-configured",
      payload: { match: ["itx", "db"], target: null },
    });
  });

  test("the REMOVAL spelling is the platform-equivalent target `itx.builtins.<match…>` (the reduce deletes the row)", () => {
    expect(
      normalizeControlEvent({
        type: "events.iterate.com/itx/rewrite-rule-configured",
        payload: { match: "itx.kv", target: restoreRuleTarget("itx.kv") },
      }).payload,
    ).toEqual({
      match: ["itx", "kv"],
      target: ["itx", "builtins", "kv"], // the parsed form at rest
    });
    expect(
      normalizeControlEvent({
        type: "events.iterate.com/itx/rewrite-rule-configured",
        payload: { match: "itx.ai.run('gpt-5')", target: restoreRuleTarget("itx.ai.run('gpt-5')") },
      }).payload,
    ).toEqual({
      match: ["itx", "ai", ["run", "gpt-5"]],
      target: ["itx", "builtins", "ai", ["run", "gpt-5"]],
    });
    expect(
      normalizeControlEvent({
        type: "events.iterate.com/itx/rewrite-rule-configured",
        payload: { match: "itx", target: restoreRuleTarget("itx") },
      }).payload,
    ).toEqual({
      match: ["itx"],
      target: ["itx", "builtins"],
    });
  });

  // THE DOOR'S REFUSALS, one row each: `{ match, target, throws }` — rule 6 (rooting, the reserved
  // root, the proxy's verbs), rule 7 (`@` in a match, in a non-final step, in a call), and the
  // prefix grammar (an argless pinned step, an anonymous step, an unbalanced paren, a non-identifier
  // step in the ARRAY half).
  const doorRefusals: {
    match: ItxExpressionInput;
    target: ItxExpressionInput | null;
    throws: RegExp;
  }[] = [
    { match: "itx.evil", target: "kv", throws: /must be rooted at "itx"/ }, // a bare built-in root is unspellable
    { match: "itx.x", target: ["kv", "get"], throws: /must be rooted at "itx"/ },
    { match: "itx.builtins", target: "itx.kv", throws: /itx\.builtins/ }, // the fixed point is never a name a rule claims
    {
      match: "itx.builtins.kv",
      target: "itx.whoami",
      throws: /may not be rooted at "itx\.builtins"/,
    },
    { match: "itx", target: "itx.cam", throws: /whole-context override .* "itx\.builtins/ }, // a short target would be its own next match
    ...["cd", "invoke", "provide", "subscribe"].map((verb) => ({
      match: `itx.${verb}`,
      target: "itx.kv",
      throws: new RegExp(`may not start with the proxy's own verb "${verb}"`),
    })),
    { match: "itx.cd('/x')", target: "itx.kv", throws: /proxy's own verb "cd"/ },
    { match: "itx.a(@)", target: "itx.kv", throws: /legal only in a rewrite rule's target/ }, // rule 7: never in a match…
    { match: ["itx", ["a", { "@": true }]], target: "itx.kv", throws: /not its match/ }, // …in either half
    {
      match: "itx.x",
      target: "itx.ai.run(@).then",
      throws: /legal only in the target's FINAL step/,
    },
    { match: "itx.a()", target: "itx.kv", throws: /pins literal args.*spell "a"/ }, // an argless pinned step pins nothing
    { match: "itx.a('x')(1)", target: "itx.kv", throws: /cannot call a result/ },
    { match: "itx.broken(", target: "itx.kv", throws: /unbalanced/ },
    { match: ["itx", "builtins.kv"], target: "itx.kv", throws: /not an identifier/ }, // the ARRAY half reads like the string half
    { match: ["itx", "a b"], target: "itx.kv", throws: /not an identifier/ },
    { match: ["itx", "cd.x"], target: "itx.kv", throws: /not an identifier/ }, // …a dotted step never bypasses the proxy-verb refusal
    { match: ["itx", ["builtins.kv", 1]], target: "itx.kv", throws: /not an identifier/ }, // …a call step's name too
    { match: ["itx", "__proto__"], target: "itx.kv", throws: /reserved/ },
  ];
  for (const { match, target, throws } of doorRefusals)
    test(`REFUSED: ${JSON.stringify(match)} ⇒ ${JSON.stringify(target)}  ${throws}`, () => {
      expect(() =>
        normalizeControlEvent({
          type: "events.iterate.com/itx/rewrite-rule-configured",
          payload: { match: match, target: target },
        }),
      ).toThrow(throws);
    });

  // …and what the door ACCEPTS: both halves the PARSED form (either codec half in), `{ match, target, payload }`.
  const doorAccepts: { match: ItxExpressionInput; target: ItxExpressionInput; payload: unknown }[] =
    [
      {
        match: "itx.db",
        target: "itx.builtins.kv",
        payload: { match: ["itx", "db"], target: ["itx", "builtins", "kv"] },
      }, // a target may name the physical spelling
      {
        match: "itx.archive",
        target: "itx.cd('/archive')",
        payload: { match: ["itx", "archive"], target: ["itx", ["cd", "/archive"]] },
      }, // …and a proxy verb (a built-in root in an expression)
      {
        match: "itx.ai.run('gpt-5')",
        target: "itx.kv",
        payload: { match: ["itx", "ai", ["run", "gpt-5"]], target: ["itx", "kv"] },
      }, // pinned args in the match, parsed once at the door
      {
        match: ["itx", "ok", ["get", 1]],
        target: "itx.kv",
        payload: { match: ["itx", "ok", ["get", 1]], target: ["itx", "kv"] },
      }, // the ARRAY half of a match passes through as the parsed form
    ];
  for (const { match, target, payload } of doorAccepts)
    test(`ACCEPTED: ${JSON.stringify(match)} ⇒ ${JSON.stringify(target)}`, () => {
      expect(
        normalizeControlEvent({
          type: "events.iterate.com/itx/rewrite-rule-configured",
          payload: { match: match, target: target },
        }).payload,
      ).toEqual(payload);
    });
});

// ───────────────────────────── what a dead stub's un-set removes ─────────────────────────────

// When a lent stub's last pager closes, the DO un-sets every row that NAMES its key — decided against
// ONE frozen table: the rows naming the key directly, plus the rows that still resolve to it once
// those are gone. Order-independent by construction: a user's alias to a shadowed root (`itx.llm ⇒
// itx.ai` while `itx.ai` is a lent fake) survives the fake dying whichever row was configured first.
describe("rowsNamingRpcStub — decided against a frozen table, whatever the configuration order", () => {
  const alias = "itx.llm ⇒ itx.ai";
  const fake = "itx.ai ⇒ itx.builtins.rpcStubs.get('itx.ai')";
  const ownRegistry = "itx.reg ⇒ itx.builtins.rpcStubs";
  const throughOwnRegistry = "itx.cam ⇒ itx.reg.get('itx.ai')";
  for (const [order, rules] of [
    ["alias first", [alias, fake, ownRegistry, throughOwnRegistry]],
    ["stub first", [fake, alias, ownRegistry, throughOwnRegistry]],
  ] as const)
    test(`${order}: the fake's own row and a row naming the key through the user's own registry go; the alias stays`, () => {
      const { ruleUnsets, subscriptionNames } = rowsNamingRpcStub({
        rpcStubKey: "itx.ai",
        rules: table([...rules]),
        subscriptionTargets: {
          viaShortSpelling: parse("itx.rpcStubs.get('itx.ai')"),
          viaAlias: parse("itx.llm.notify"),
        },
      });
      expect(ruleUnsets.map((u) => print(u.match)).sort()).toEqual(["itx.ai", "itx.cam"]);
      // each unset carries the target the census saw, so the DO's removal is a compare-and-set
      expect(
        Object.fromEntries(ruleUnsets.map((u) => [print(u.match), print(u.ifTarget)])),
      ).toEqual({
        "itx.ai": "itx.builtins.rpcStubs.get('itx.ai')",
        "itx.cam": "itx.reg.get('itx.ai')",
      });
      // the short spelling names the registry through the platform row and goes; the alias-spelled
      // subscription resolves to the platform `ai` beneath once the fake is gone, and stays
      expect(subscriptionNames).toEqual(["viaShortSpelling"]);
    });
});

// ───────────────────────────── the resolver, over the reduce as the DO runs it ─────────────────────────────

/** A tiny fake built-ins record — enough physical layer to rewrite into. */
const fakeBuiltIns = () => {
  const kv = new Map<string, string>();
  const aiCalls: unknown[] = [];
  return {
    kv: {
      get: (k: string) => kv.get(k) ?? null,
      put: (k: string, v: string) => {
        kv.set(k, v);
        return { ok: true };
      },
    },
    whoami: () => ({ projectId: "prj_t", path: "/" }),
    // the Workers AI binding's shape, verbatim: run(model, inputs, options?) and gateway(id).run(req)
    // — plus a `chat` the rows alias to (a REAL root name: the resolver's platform rows come from the
    // leaf list, context/itx-expression-rewriting.ts)
    ai: {
      run: (model: string, inputs?: unknown, options?: unknown) => ({ model, inputs, options }),
      gateway: (id: string) => ({ run: (request: unknown) => ({ gateway: id, request }) }),
      chat: (o: { model: string }) => {
        aiCalls.push(o);
        return `chat:${o.model}`;
      },
    },
    aiCalls,
  };
};

const setup = () => {
  const { stream, events } = memoryStream();
  const core = { reduce: reduceCoreEvent, contract: CoreContract }; // the DO's inline reduce, as functions
  const builtIns = fakeBuiltIns();
  // INLINE, exactly like the DO: the rules are core state, reduced from the durable log per call —
  // and, as in Stream.#reduceEventsIntoCoreReducedState, a malformed control event is skipped
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
  // The fake `itx.builtins.rpcStubs` BUILT-IN — the physical registry behind a lent stub, keyed by the
  // opaque rpcStubKey, exactly like the DO's RpcStubDirectory. _lend/_recall simulate a lend / a final
  // recall. A rule names an entry through the pure-data target `itx.builtins.rpcStubs.get('<key>')`;
  // nothing about the registry is in the log.
  const lentRpcStubs = new Map<string, unknown>();
  const rpcStubs = {
    get: (rpcStubKey: string) =>
      new InvokeHandle((itxExpressionSteps) => {
        let value = lentRpcStubs.get(rpcStubKey) as
          | Record<string, unknown>
          | ((...a: unknown[]) => unknown);
        if (!value) throw new Error(`rpc stub "${rpcStubKey}" is offline`);
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
  /** The edge's `provide(match, expression | null)`: build the ONE event, append it. A refusal throws
   *  at the door — nothing is appended. */
  const rewrite = (match: ItxExpressionInput, target: ItxExpressionInput | null) =>
    (
      stream.append(
        normalizeControlEvent({
          type: "events.iterate.com/itx/rewrite-rule-configured",
          payload: { match: match, target: target },
        }),
      ) as StreamEvent[]
    )[0];
  /** The edge's `provide(match, stub)`, spelled out: lend under the key (= the match), configure the
   *  pure-data rule naming the PHYSICAL registry. */
  const provide = (rpcStubKey: string, stub: unknown) => {
    lentRpcStubs.set(rpcStubKey, stub);
    return rewrite(rpcStubKey, `itx.builtins.rpcStubs.get('${rpcStubKey}')`);
  };
  return {
    stream,
    events,
    builtIns,
    rewriteRules,
    invoke: (call: ItxExpressionInput, ...args: unknown[]) => resolver.invoke(call, ...args),
    resolve: (call: ItxExpressionInput) => resolver.resolve(call).map((step) => print(step)),
    rewrite,
    remove: (match: ItxExpressionInput) =>
      (
        stream.append(
          normalizeControlEvent({
            type: "events.iterate.com/itx/rewrite-rule-configured",
            payload: { match: match, target: restoreRuleTarget(match) },
          }),
        ) as StreamEvent[]
      )[0],
    provide,
    _lend: (rpcStubKey: string, stub: unknown) => lentRpcStubs.set(rpcStubKey, stub),
    _recall: (rpcStubKey: string) => lentRpcStubs.delete(rpcStubKey),
  };
};

describe("built-in resolution + default-deny", () => {
  test("built-ins resolve directly (no rule, no config) — through the implicit platform row, or at the fixed point", async () => {
    const { invoke } = setup();
    expect(await invoke("itx.whoami()")).toEqual({ projectId: "prj_t", path: "/" });
    expect(await invoke("itx.builtins.whoami()")).toEqual({ projectId: "prj_t", path: "/" });
    expect(await invoke("itx.kv.put('a', '1')")).toEqual({ ok: true });
    expect(await invoke("itx.builtins.kv.get('a')")).toBe("1");
  });

  test("default-deny: no match is a readable, CODED error — under the reserved root too", async () => {
    const { invoke } = setup();
    await expect(invoke("itx.nope.thing()")).rejects.toMatchObject({
      code: "NO_ITX_EXPRESSION_MATCH",
      message: expect.stringMatching(/no rewrite rule matches.*itx\.nope\.thing/),
    });
    await expect(invoke("itx.builtins.nope()")).rejects.toMatchObject({
      code: "NO_ITX_EXPRESSION_MATCH",
      message: expect.stringMatching(/no built-in "nope" under itx\.builtins/),
    });
    await expect(invoke("itx.builtins")).rejects.toThrow(/names the reserved root/);
  });

  test("THE LAW: invoking a call equals invoking the last element of its resolution", async () => {
    const { invoke, resolve, rewrite, provide } = setup();
    provide("itx.cam", { shot: (n: unknown) => `frame ${n}` });
    rewrite("itx.db", "itx.kv");
    rewrite("itx.snap", "itx.cam.shot");
    await invoke("itx.db.put('k', 'v')");
    for (const call of [
      "itx.whoami()",
      "itx.db.get('k')",
      "itx.builtins.kv.get('k')",
      "itx.cam.shot(1)",
      "itx.snap(2)",
    ]) {
      const chain = resolve(call);
      expect(chain[0]).toBe(print(parse(call)));
      expect(await invoke(chain.at(-1)!)).toEqual(await invoke(call));
    }
  });

  test("`invoke(call, ...args)`: live args are applied to the value the expression denotes (the fetch lane's shape)", async () => {
    const { invoke } = setup();
    await invoke("itx.kv.put", "k", "v");
    expect(await invoke("itx.kv.get", "k")).toBe("v");
    expect(await invoke("itx.kv.get", "k")).toEqual(await invoke("itx.kv.get('k')"));
    expect(await invoke("itx.whoami()")).toEqual({ projectId: "prj_t", path: "/" }); // no args: the call as spelled
    expect(typeof (await invoke("itx.whoami"))).toBe("function"); // no args, no call: the value the expression denotes
  });

  test("`invoke(call, ...args)` folds the live args into a name-final call BEFORE resolving: a template fills from them, a pinned row and a pinned mask see them; a call-final expression applies them to the value it denotes", async () => {
    const { invoke, rewrite, provide } = setup();
    provide("itx.s", (...args: unknown[]) => ["stubbed", args]);
    rewrite("itx.fable", "itx.ai.run('@cf/x', @)");
    rewrite("itx.ai.run('gpt-5')", "itx.builtins.rpcStubs.get('itx.s')");
    rewrite("itx.kv.get('secret')", null);
    // the template fills from the live args, exactly as the dotted call would
    expect(await invoke("itx.fable", { prompt: "hi" })).toEqual({
      model: "@cf/x",
      inputs: { prompt: "hi" },
      options: undefined,
    });
    // a pinned row matches the live args; the unpinned tail is the call on the target
    expect(await invoke("itx.ai.run", "gpt-5", { q: 1 })).toEqual(["stubbed", [{ q: 1 }]]);
    // a pinned mask refuses the live args it claims (default-deny); a sibling arg reaches the root
    await expect(invoke("itx.kv.get", "secret")).rejects.toMatchObject({
      code: "NO_ITX_EXPRESSION_MATCH",
    });
    expect(await invoke("itx.kv.get", "public")).toBeNull();
    // a call-final expression keeps the old shape: the args apply to the value it denotes
    expect(await invoke("itx.builtins.rpcStubs.get('itx.s')", 1, 2)).toEqual(["stubbed", [1, 2]]);
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

  test("a hand-built call step at the scope root is refused by the codec — the ARRAY half reads like the string half (`itx(1)` never parses), before any rule is consulted", async () => {
    const { invoke } = setup();
    await expect(invoke([["itx", 1]])).rejects.toThrow(/a call on the root itself/);
  });
});

describe("the rule table — a MAP by match: set replaces, null masks or deletes, the platform-equivalent target restores", () => {
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
    // the kv value's (non-existent) `deep`.
    expect(await invoke("itx.db.deep()")).toEqual(await invoke("itx.whoami()"));
    expect(await invoke("itx.db.get('missing')")).toBeNull(); // the shorter match still reaches kv
  });

  test("MISHA'S TEST: a rule at a built-in's name SHADOWS it; removing the rule gives the real one back; the physical spelling never moved", async () => {
    const { provide, invoke, remove, rewriteRules } = setup();
    provide("itx.whoami", () => ({ projectId: "fake", path: "/fake" }));
    expect(await invoke("itx.whoami()")).toEqual({ projectId: "fake", path: "/fake" });
    expect(await invoke("itx.builtins.whoami()")).toEqual({ projectId: "prj_t", path: "/" });
    remove("itx.whoami"); // what a disposed handle / a dead stub appends
    expect(await invoke("itx.whoami()")).toEqual({ projectId: "prj_t", path: "/" });
    expect(rewriteRules().some((rule) => print(rule.match) === "itx.whoami")).toBe(false);
  });

  test("a MASK: `null` at a built-in's name is KEPT as a row and refuses the call; the removal spelling lifts it; `null` elsewhere simply deletes", async () => {
    const { rewrite, remove, invoke, rewriteRules, events } = setup();
    rewrite("itx.kv", null);
    expect(rewriteRules().find((rule) => print(rule.match) === "itx.kv")?.target).toBeNull();
    await expect(invoke("itx.kv.put('a', '1')")).rejects.toMatchObject({
      code: "NO_ITX_EXPRESSION_MATCH",
      message: expect.stringMatching(/is masked/),
    });
    expect(await invoke("itx.builtins.kv.put('a', '1')")).toEqual({ ok: true }); // the physical door still answers
    const masked = events.length;
    rewrite("itx.kv", null); // a second deny is a no-op: the event lands, the state is unchanged
    expect(events).toHaveLength(masked + 1);
    remove("itx.kv"); // `itx.kv ⇒ itx.builtins.kv` — back to the platform row: the row is GONE, not restated
    expect(rewriteRules().some((rule) => print(rule.match) === "itx.kv")).toBe(false);
    expect(await invoke("itx.kv.get('a')")).toBe("1");
    // a deny at a name with nothing beneath is a deletion (no mask row to carry)
    rewrite("itx.never", null);
    expect(rewriteRules().some((rule) => print(rule.match) === "itx.never")).toBe(false);
  });

  test("a PARTIAL mask under a built-in root refuses only what it claims", async () => {
    const { rewrite, invoke } = setup();
    rewrite("itx.kv.get", null);
    expect(await invoke("itx.kv.put('a', '1')")).toEqual({ ok: true });
    await expect(invoke("itx.kv.get('a')")).rejects.toThrow(/is masked/);
    rewrite("itx.kv.get", "itx.kv.put"); // a target replaces the mask
    expect(await invoke("itx.kv.get('b', '2')")).toEqual({ ok: true });
  });

  test("a provided stub is an ordinary rule whose target names the PHYSICAL registry — pure data, nothing about the socket", () => {
    const { events, provide } = setup();
    provide("itx.cam", { shot: () => "frame" });
    expect(events.at(-1)!.payload).toEqual({
      match: ["itx", "cam"],
      target: ["itx", "builtins", "rpcStubs", ["get", "itx.cam"]],
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

  test("a re-set REPLACES the rule at that match; `null` DELETES it (nothing beneath); setting the old target back restores it (no stack)", async () => {
    const { rewrite, invoke, provide, rewriteRules } = setup();
    provide("itx.tab1", { hello: () => "from tab-1" });
    provide("itx.tab2", { hello: () => "from tab-2" });
    rewrite("itx.greeter", "itx.tab1");
    rewrite("itx.greeter", "itx.tab2");
    expect(await invoke("itx.greeter.hello()")).toBe("from tab-2"); // replaced
    expect(rewriteRules().filter((rule) => print(rule.match) === "itx.greeter")).toHaveLength(1);
    rewrite("itx.greeter", null);
    await expect(invoke("itx.greeter.hello()")).rejects.toThrow(/no rewrite rule matches/); // gone, nothing beneath
    expect(rewriteRules().some((rule) => print(rule.match) === "itx.greeter")).toBe(false);
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
    rewrite("itx.grok", "itx.ai.chat");
    expect(await invoke("itx.grok({ model: 'grok-4' })")).toBe("chat:grok-4");
    expect(builtIns.aiCalls[0]).toEqual({ model: "grok-4" });
  });

  test("THE DREAM, through the reduce: `itx.fable ⇒ itx.ai.run('@cf/…', @)` is one row at rest; the caller's inputs fill `@`; `...@` pins a gateway model", async () => {
    const { rewrite, invoke, resolve, events } = setup();
    rewrite("itx.fable", "itx.ai.run('@cf/meta/llama-3.2-1b-instruct', @)");
    expect(events.at(-1)!.payload).toEqual({
      match: ["itx", "fable"],
      target: ["itx", "ai", ["run", "@cf/meta/llama-3.2-1b-instruct", { "@": true }]], // `@` at rest is the reserved literal
    });
    expect(await invoke("itx.fable({ prompt: 'hi' })")).toEqual({
      model: "@cf/meta/llama-3.2-1b-instruct",
      inputs: { prompt: "hi" },
      options: undefined,
    });
    expect(await invoke("itx.fable({ prompt: 'hi' }, { gateway: { id: 'g' } })")).toMatchObject({
      options: { gateway: { id: "g" } },
    });
    expect(resolve("itx.fable({ prompt: 'hi' })")).toEqual([
      "itx.fable({prompt:'hi'})",
      "itx.ai.run('@cf/meta/llama-3.2-1b-instruct',{prompt:'hi'})",
      "itx.builtins.ai.run('@cf/meta/llama-3.2-1b-instruct',{prompt:'hi'})",
    ]);
    rewrite(
      "itx.claude",
      "itx.ai.gateway('g').run({ provider: 'anthropic', endpoint: 'v1/messages', query: { model: 'claude-x', ...@ } })",
    );
    expect(await invoke("itx.claude({ messages: ['hi'], model: 'evil' })")).toEqual({
      gateway: "g",
      request: {
        provider: "anthropic",
        endpoint: "v1/messages",
        query: { messages: ["hi"], model: "claude-x" }, // the template's model wins
      },
    });
  });

  test("THE WHOLE-CONTEXT OVERRIDE: a lent stub at bare `itx` catches EVERY short-named call — built-ins included — while `itx.builtins.…` stays physical", async () => {
    const { invoke, provide, remove } = setup();
    const osCalls: string[] = [];
    provide("itx", {
      anything: (...a: unknown[]) => {
        osCalls.push(`anything(${a.join(",")})`);
        return "handled upstream";
      },
      whoami: () => "the override's whoami",
    });
    expect(await invoke("itx.anything('x')")).toBe("handled upstream");
    expect(osCalls).toEqual(["anything(x)"]);
    expect(await invoke("itx.whoami()")).toBe("the override's whoami"); // rules first: the platform row is shadowed
    expect(await invoke("itx.builtins.whoami()")).toEqual({ projectId: "prj_t", path: "/" });
    remove("itx"); // `itx ⇒ itx.builtins`: the override is gone
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

  test("un-setting a match with no rule is a no-op — the event lands, the table still resolves", async () => {
    const { rewrite, invoke, events } = setup();
    rewrite("itx.never", null);
    expect(events).toHaveLength(1); // the event lands; the reduce keeps the state
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
    rewrite("itx.chat", ["itx", "ai", ["chat", { "a b": "grok-4" }]]);
    // ai.chat reads o.model (absent here) → "chat:undefined"; the point is it REWRITES at all.
    expect(await invoke("itx.chat")).toBe("chat:undefined");
  });
});
