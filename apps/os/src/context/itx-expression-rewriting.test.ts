// context/itx-expression-rewriting.test.ts — THE TABLE: given these rewrite rules and this call, this
// is the call that runs. Every rule in itx-expression-rewriting.ts is a row here; read the rows, not
// the code. Rules are written `"match ⇒ target"`; `null` is a MASK. Built-in roots for the table: kv,
// whoami, rpcStubs, ai — reached as `itx.builtins.<root>` (the fixed point) or through the implicit
// platform row `itx.<root> ⇒ itx.builtins.<root>`. Below the table: the ONE append-boundary check
// (`normalizeRewriteRuleConfigured`), the resolver over a fake physical scope
// (rules first, masks, the fixed point, default-deny, depth 32, lent stubs through a fake
// `itx.builtins.rpcStubs`), and the reduce as the DO runs it — the rules are `core` state, reduced
// from the log.
import { expect, test } from "vitest";
import {
  parse,
  parseItxExpressionPrefix,
  print,
  type ItxExpression,
  type ItxExpressionInput,
  InvokeHandle,
} from "iterate/expression";
import type { RewriteRuleListEntry } from "iterate/api";
import { normalizeControlEvent } from "../stream/core-processor.ts";
import { nodeSqliteStream } from "../stream/test-support.ts";
import {
  ItxExpressionResolver,
  type ItxExpressionRewriteRule,
  matchItxExpressionPrefix,
  resolveItxExpression,
  rowsNamingRpcStub,
  BUILT_IN_ROOTS,
  BUILT_IN_ROOT_DESCRIPTIONS,
  CONTEXT_ROOTS,
  admitLoadedCodeRow,
  describeRewriteRules,
} from "./itx-expression-rewriting.ts";

/** The roots implicit at the owner root (every built-in) and at a child (the context roots) —
 *  `implicitRootsAt` for the two kinds of path, without a projectId. */
const ROOT: ReadonlySet<string> = new Set(BUILT_IN_ROOTS);
const CHILD: ReadonlySet<string> = new Set(CONTEXT_ROOTS);

const resolveRows: { rules: string[]; call: string; becomes: string }[] = [
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
  // A BARE `itx` ROW WITH A TARGET claims only what no implicit row claims (`implicitRootsAt`): at the owner
  // root every built-in is implicit, so only an unknown name goes to the row — the context's own
  // `append` stays its own.
  {
    rules: ["itx ⇒ itx.builtins.rpcStubs.get('itx')"],
    call: "itx.anything({ type: 't' })",
    becomes: "itx.builtins.rpcStubs.get('itx').anything({type:'t'})",
  },
  {
    rules: ["itx ⇒ itx.builtins.rpcStubs.get('itx')"],
    call: "itx.append({ type: 't' })",
    becomes: "itx.builtins.append({type:'t'})",
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
  // `@` IS THE CALLER'S INPUT (`fillItxExpressionHoles`): the target is a TEMPLATE, the fold of the
  // caller's args into the rewritten call does not apply.
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
for (const { rules, call, becomes } of resolveRows)
  test(`resolveItxExpression — the call that runs: ${call}  with  [${rules.join(" | ") || "no rules"}]  runs  ${becomes}`, () => {
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
  // …a partial mask refuses only what it claims (the sibling call runs — see the resolveRows above)
  { rules: ["itx.kv.get ⇒ null"], call: "itx.kv.get('k')", throws: /is masked/ },
  // …a bare `itx` mask denies every short-named call
  { rules: ["itx ⇒ null"], call: "itx.whoami()", throws: /is masked/ },
  // …a mask reached THROUGH another rule still refuses (rules first, at every step)
  { rules: ["itx.db ⇒ itx.kv", "itx.kv ⇒ null"], call: "itx.db.get('k')", throws: /is masked/ },
  // a literal that differs and no plain rule beneath → nothing matches (`llm` is no root; `itx.ai`
  // would fall to its platform row — see the pinned-args resolveRows above)
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
  // a bare `itx` row with a SHORT, unclaimed target claims its own target: a loop, refused by the
  // depth budget — a name an implicit row answers never re-enters it (`itx.append` above)
  { rules: ["itx ⇒ itx.cam.get('itx')"], call: "itx.nothing(1)", throws: /depth 32/ },
  // `@` refusals (`fillItxExpressionHoles`): a nested `@` or a `...@` needs EXACTLY one argument — never a guess
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
  test(`resolveItxExpression — the call that runs: ${call}  with  [${rules.join(" | ") || "no rules"}]  is refused: ${throws}`, () => {
    expect(runs(rules, call)).toMatch(throws);
  });

test("resolveItxExpression — the call that runs: the depth budget: 32 REWRITES resolve (31 rules + the platform row), 33 trip", () => {
  const chainOf = (n: number) =>
    Array.from({ length: n }, (_, i) => `itx.c${i} ⇒ ${i === 0 ? "itx.whoami" : `itx.c${i - 1}`}`);
  expect(runs(chainOf(31), "itx.c30()")).toBe("itx.builtins.whoami()"); // 31 rules + the platform row = 32
  expect(runs(chainOf(32), "itx.c31()")).toMatch(/depth 32/);
});

test("resolveItxExpression — the call that runs: THE CHAIN: every rewrite in order, the call itself first, the builtins-rooted call last", () => {
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

test("resolveItxExpression — the call that runs: AT A CHILD only the context roots are implicit: a project root hops through the parent link, the context's own log stays its own, and a bare null denies all", () => {
  const link = ["itx ⇒ itx.builtins.cd('/agents/a')"];
  const runsAt = (rules: string[], call: string, roots: ReadonlySet<string>) =>
    print(resolveItxExpression(() => table(rules), parse(call), roots).at(-1)!);
  expect(runsAt(link, "itx.kv.get('k')", CHILD)).toBe("itx.builtins.cd('/agents/a').kv.get('k')");
  expect(runsAt(link, "itx.tool.hello()", CHILD)).toBe("itx.builtins.cd('/agents/a').tool.hello()");
  expect(runsAt(link, "itx.append({ type: 't' })", CHILD)).toBe("itx.builtins.append({type:'t'})");
  expect(runsAt(link, "itx.cd('./x').whoami()", CHILD)).toBe("itx.builtins.cd('./x').whoami()");
  expect(() => runsAt([], "itx.kv.get('k')", CHILD)).toThrow(/no rewrite rule matches/);
  expect(() => runsAt(["itx ⇒ null"], "itx.append(1)", CHILD)).toThrow(/is masked/);
  expect(runsAt(["itx ⇒ null", "itx.append ⇒ itx.builtins.append"], "itx.append(1)", CHILD)).toBe(
    "itx.builtins.append(1)",
  );
});

test("resolveItxExpression — the call that runs: `abort` is a CONTEXT root: under a parent link a child's `itx.abort()` resets the child itself, never the context the link names; a row or a bare null takes it away", () => {
  const link = ["itx ⇒ itx.builtins.cd('/agents/a')"];
  const runsAt = (rules: string[], call: string) =>
    print(resolveItxExpression(() => table(rules), parse(call), CHILD).at(-1)!);
  expect(runsAt(link, "itx.abort('r')")).toBe("itx.builtins.abort('r')");
  expect(runsAt(link, "itx.facets.abort('f')")).toBe("itx.builtins.facets.abort('f')");
  expect(() => runsAt([...link, "itx.abort ⇒ null"], "itx.abort()")).toThrow(/is masked/);
  expect(() => runsAt(["itx ⇒ null"], "itx.abort()")).toThrow(/is masked/);
  expect(() => runsAt(["itx ⇒ null"], "itx.facets.abort('f')")).toThrow(/is masked/);
});

test("resolveItxExpression — the call that runs: a builtins-rooted call NEVER reads the table (the fixed point is checked before the rules)", () => {
  const neverRead = () => {
    throw new Error("the table was read");
  };
  expect(
    print(resolveItxExpression(neverRead, parse("itx.builtins.kv.get('k')"), ROOT).at(-1)!),
  ).toBe("itx.builtins.kv.get('k')");
  // …while a short name does (and the read happens once)
  expect(() => resolveItxExpression(neverRead, parse("itx.kv.get('k')"), ROOT)).toThrow(
    /the table was read/,
  );
});

test("resolveItxExpression — the call that runs: a singular worker name has no implicit platform resolution", () => {
  const target: ItxExpression = ["itx", "workers", ["get", { source: { "worker.js": "source" } }]];
  expect(() => resolveItxExpression(() => [], ["itx", "worker", "fetch"], ROOT)).toThrow(
    "no rewrite rule matches",
  );
  expect(resolveItxExpression(() => [], target, ROOT).at(-1)).toEqual([
    "itx",
    "builtins",
    ...target.slice(1),
  ]);
});

const prefixRows: {
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
for (const { match, call, claims } of prefixRows)
  test(`matchItxExpressionPrefix — one match against one call: ${match}  against  ${call}  →  ${claims ? `${print(claims.stepsAfterMatch) || "(nothing after)"}${claims.unpinnedArgs ? `, unpinned ${JSON.stringify(claims.unpinnedArgs)}` : ""}` : "no match"}`, () => {
    expect(matchItxExpressionPrefix(parseItxExpressionPrefix(match), parse(call))).toEqual(claims);
  });

test("the anonymous call step round-trips the codec: `f(x)(y)` parses to an anonymous call and prints back; a prefix may not use it", () => {
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

test("`@` round-trips the codec (targets only): parse → print → parse; the one reserved literal: `@` and `...@` lex to the marker literals and print back; nothing inside quotes is touched", () => {
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
  expect(parse(`itx.kv.put('k',"{'@':true}")`)).toEqual(["itx", "kv", ["put", "k", "{'@':true}"]]);
});

test("`@` round-trips the codec (targets only): parse → print → parse; the one reserved literal: a bare `@` in a CALL (or any parse without `holes`) is refused in the marker's own words", () => {
  expect(() => parse("itx.kv.get(@)")).toThrow(/legal only in a rewrite rule's target/);
  expect(() => parse("itx.ai.run({ q: ...@ })")).toThrow(/legal only in a rewrite rule's target/);
  expect(parse("itx.kv.get('a@b', \"x@y\")")).toEqual(["itx", "kv", ["get", "a@b", "x@y"]]);
});

// ───────────────────────────── the append boundary ─────────────────────────────

test("rewrite-rule-configured — ONE event, both halves canonical, loud at the append boundary: AT REST: BOTH halves are the PARSED form (either codec half in, the parsed form out) — the reduce keys the table by printing the match, so a canonical match over the codec cap never re-parses", () => {
  expect(
    normalizeControlEvent(
      {
        type: "events.iterate.com/itx/rewrite-rule-configured",
        payload: { match: "itx.db", target: ["itx", "facets", ["get", "tab-1"]] },
      },
      "/",
    ),
  ).toEqual({
    type: "events.iterate.com/itx/rewrite-rule-configured",
    payload: { match: ["itx", "db"], target: ["itx", "facets", ["get", "tab-1"]] },
  });
  // either codec half on either side, parsed once at the append boundary
  expect(
    normalizeControlEvent(
      {
        type: "events.iterate.com/itx/rewrite-rule-configured",
        payload: { match: ["itx", "db"], target: "itx.facets.get('tab-1')" },
      },
      "/",
    ),
  ).toEqual({
    type: "events.iterate.com/itx/rewrite-rule-configured",
    payload: { match: ["itx", "db"], target: ["itx", "facets", ["get", "tab-1"]] },
  });
});

test("rewrite-rule-configured — ONE event, both halves canonical, loud at the append boundary: `null` target is the deny: the same event, target null", () => {
  expect(
    normalizeControlEvent(
      {
        type: "events.iterate.com/itx/rewrite-rule-configured",
        payload: { match: "itx.db", target: null },
      },
      "/",
    ),
  ).toEqual({
    type: "events.iterate.com/itx/rewrite-rule-configured",
    payload: { match: ["itx", "db"], target: null },
  });
});

// THE APPEND BOUNDARY'S REFUSALS, one row each: `{ match, target, throws }` — rooting, the reserved
// root, the proxy's verbs, `@` (in a match, in a non-final step, in a call), and the
// prefix grammar (an argless pinned step, an anonymous step, an unbalanced paren, a non-identifier
// step in the ARRAY half).
const appendRefusals: {
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
  // a bare row's short target is legal at the append boundary — it loops at resolve time, where the budget catches it
  ...["invoke", "provide", "subscribe"].map((verb) => ({
    match: `itx.${verb}`,
    target: "itx.kv",
    throws: new RegExp(`may not start with the proxy's own verb "${verb}"`),
  })),
  // `cd` is a NAME, not a proxy verb: `itx.cd ⇒ null` (a wall) and `itx.cd('/x') ⇒ …` are rows
  { match: "itx.a(@)", target: "itx.kv", throws: /legal only in a rewrite rule's target/ }, // `@`: never in a match…
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
for (const { match, target, throws } of appendRefusals)
  test(`rewrite-rule-configured — ONE event, both halves canonical, loud at the append boundary: REFUSED: ${JSON.stringify(match)} ⇒ ${JSON.stringify(target)}  ${throws}`, () => {
    expect(() =>
      normalizeControlEvent(
        {
          type: "events.iterate.com/itx/rewrite-rule-configured",
          payload: { match: match, target: target },
        },
        "/",
      ),
    ).toThrow(throws);
  });

// …and what the append boundary ACCEPTS: both halves the PARSED form (either codec half in), `{ match, target, payload }`.
const accepted: { match: ItxExpressionInput; target: ItxExpressionInput; payload: unknown }[] = [
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
  }, // pinned args in the match, parsed once at the append boundary
  {
    match: ["itx", "ok", ["get", 1]],
    target: "itx.kv",
    payload: { match: ["itx", "ok", ["get", 1]], target: ["itx", "kv"] },
  }, // the ARRAY half of a match passes through as the parsed form
  // The physical spelling of the match itself is an ordinary target at the append boundary — the
  // REDUCE decides: a deletion where it restates the implicit row, a grant where it does not.
  {
    match: "itx.kv",
    target: "itx.builtins.kv",
    payload: { match: ["itx", "kv"], target: ["itx", "builtins", "kv"] },
  },
  {
    match: "itx.ai.run('gpt-5')",
    target: "itx.builtins.ai.run('gpt-5')",
    payload: {
      match: ["itx", "ai", ["run", "gpt-5"]],
      target: ["itx", "builtins", "ai", ["run", "gpt-5"]],
    },
  },
  {
    match: "itx",
    target: "itx.builtins",
    payload: { match: ["itx"], target: ["itx", "builtins"] },
  },
];
for (const { match, target, payload } of accepted)
  test(`rewrite-rule-configured — ONE event, both halves canonical, loud at the append boundary: ACCEPTED: ${JSON.stringify(match)} ⇒ ${JSON.stringify(target)}`, () => {
    expect(
      normalizeControlEvent(
        {
          type: "events.iterate.com/itx/rewrite-rule-configured",
          payload: { match: match, target: target },
        },
        "/",
      ),
    ).toEqual({ type: "events.iterate.com/itx/rewrite-rule-configured", payload });
  });

test("rewrite-rule-configured — ONE event, both halves canonical, loud at the append boundary: ACCEPTED: `ifTarget` (a handle's compare-and-set undo) is normalized like `target` — a string parses to the stored shape, null is the mask sentinel, the key rides through only when sent, undefined is refused", () => {
  const normalized = (payload: Record<string, unknown>) =>
    normalizeControlEvent({ type: "events.iterate.com/itx/rewrite-rule-configured", payload }, "/")
      .payload as Record<string, unknown>;
  const base = { match: ["itx", "x"], target: ["itx", "builtins", "x"] };
  expect(normalized({ match: "itx.x", target: "itx.builtins.x", ifTarget: "itx.tab1" })).toEqual({
    ...base,
    ifTarget: ["itx", "tab1"],
  });
  expect(
    normalized({ match: "itx.x", target: "itx.builtins.x", ifTarget: ["itx", "tab1"] }),
  ).toEqual({
    ...base,
    ifTarget: ["itx", "tab1"],
  });
  expect(normalized({ match: "itx.x", target: "itx.builtins.x", ifTarget: null })).toEqual({
    ...base,
    ifTarget: null,
  });
  expect("ifTarget" in normalized({ match: "itx.x", target: "itx.builtins.x" })).toBe(false);
  expect(() =>
    normalized({ match: "itx.x", target: "itx.builtins.x", ifTarget: undefined }),
  ).toThrow(/never undefined/);
  expect(() =>
    normalized({ match: "itx.x", target: "itx.builtins.x", ifTarget: "itx.(" }),
  ).toThrow();
});

test("rewrite-rule-configured — ONE event, both halves canonical, loud at the append boundary: REFUSED against the path the row LANDS on, whichever caller appends: a bare `itx` row whose target is `cd` of that context; a bare link elsewhere, a longer match, a mask and a foreign event pass; a schedule's batch is checked as it is scheduled", () => {
  const at = (ownPath: string, payload: Record<string, unknown>) => () =>
    normalizeControlEvent(
      { type: "events.iterate.com/itx/rewrite-rule-configured", payload },
      ownPath,
    );
  const loop = /would route every call back to itself/;
  expect(at("/agents/a", { match: "itx", target: "itx.builtins.cd('/agents/a')" })).toThrow(loop);
  expect(at("/agents/a", { match: "itx", target: "itx.cd('.')" })).toThrow(loop);
  expect(at("/agents/a", { match: ["itx"], target: ["itx", "builtins", ["cd", "./"]] })).toThrow(
    loop,
  );
  expect(at("/", { match: "itx", target: "itx.builtins.cd('/')" })).toThrow(loop);
  // the sibling's spelling: `/y` appends `itx ⇒ cd('/x')` to `/x` — checked against `/x`, not `/y`
  expect(at("/x", { match: "itx", target: "itx.builtins.cd('/x')" })).toThrow(loop);
  expect(at("/agents/a", { match: "itx", target: "itx.builtins.cd('/')" })).not.toThrow();
  expect(at("/agents/a", { match: "itx", target: "itx.builtins.cd('./b')" })).not.toThrow();
  expect(at("/agents/a", { match: "itx.x", target: "itx.builtins.cd('.')" })).not.toThrow();
  expect(at("/agents/a", { match: "itx", target: null })).not.toThrow();
  expect(at("/agents/a", { match: "itx", target: "itx.builtins" })).not.toThrow();
  expect(() =>
    normalizeControlEvent(
      {
        type: "events.iterate.com/itx/schedule-set",
        payload: {
          key: "k",
          when: { at: "2030-01-01T00:00:00Z" },
          events: [
            {
              type: "events.iterate.com/itx/rewrite-rule-configured",
              payload: { match: "itx", target: "itx.cd('.')" },
            },
          ],
        },
      },
      "/agents/a",
    ),
  ).toThrow(loop);
});

// ───────────────────────────── the table, described ─────────────────────────────

test("describeRewriteRules — the effective table as `rewriteRules.list()` shows it: own rows first, as spelled (a template's `@`, a mask as null), then the implicit rows here minus what an own `itx.<root>` row claims — the context roots at a child, every root at the owner root", async () => {
  const rows = ["itx.fable ⇒ itx.ai.run('m', @)", "itx.append ⇒ null"];
  expect(await listed(rows)).toEqual([
    ownRow("itx.fable", "itx.ai.run('m',@)", "/agents/a"),
    ownRow("itx.append", null, "/agents/a"),
    ...CONTEXT_ROOTS.filter((root) => root !== "append").map((root) =>
      platformRow(root, "/agents/a"),
    ),
  ]);
  expect(await listed(rows, { path: "/", implicitRoots: ROOT })).toEqual([
    ownRow("itx.fable", "itx.ai.run('m',@)", "/"),
    ownRow("itx.append", null, "/"),
    ...BUILT_IN_ROOTS.filter((root) => root !== "append").map((root) => platformRow(root, "/")),
  ]);
});

test("describeRewriteRules — the effective table as `rewriteRules.list()` shows it: a bare `itx ⇒ null` denies all: own rows only, no implicit row, no hop", async () => {
  let hopped = false;
  const rows = await listed(["itx ⇒ null", "itx.kv ⇒ itx.builtins.kv"], {
    inherit: async () => {
      hopped = true;
      return [];
    },
  });
  expect(rows).toEqual([
    ownRow("itx", null, "/agents/a"),
    ownRow("itx.kv", "itx.builtins.kv", "/agents/a"),
  ]);
  expect(hopped).toBe(false);
});

test("describeRewriteRules — the effective table as `rewriteRules.list()` shows it: a bare `itx ⇒ itx.builtins` lists every root as local: the context roots, then the rest", async () => {
  expect(await listed(["itx ⇒ itx.builtins"])).toEqual([
    ownRow("itx", "itx.builtins", "/agents/a"),
    ...CONTEXT_ROOTS.map((root) => platformRow(root, "/agents/a")),
    ...BUILT_IN_ROOTS.filter((root) => !CHILD.has(root)).map((root) =>
      platformRow(root, "/agents/a"),
    ),
  ]);
});

test("describeRewriteRules — the effective table as `rewriteRules.list()` shows it: behind a bare link, the linked context's list one hop shallower — an inherited row shown iff a call spelled like it is forwarded, the resolver's own law: hidden under a longer own row (a mask at `itx.browser` hides `itx.browser.quickAction`, `itx.kv` hides `itx.kv.get`, the same pinned row is claimed), under an implicit root here (`itx.append` stays the child's own), and never the linked context's own bare row; a pinned row with other args is forwarded, every row keeping the context it was read from", async () => {
  const hops: [string, number][] = [];
  const parentRows: RewriteRuleListEntry[] = [
    ownRow("itx", "itx.builtins.cd('/organizations/o')", "/"),
    ownRow("itx.ai.run('gpt-5')", "itx.builtins.ai.run('gpt-5-fast')", "/"),
    ownRow("itx.ai.run('b')", "itx.builtins.ai.run('b-fast')", "/"),
    ownRow("itx.browser.quickAction", "itx.builtins.browser.quickAction", "/"),
    ownRow("itx.kv.get", "itx.builtins.kv.get", "/"),
    ownRow("itx.repos.get", "itx.builtins.repos.get", "/", "the parent's repos"),
    platformRow("append", "/"),
    platformRow("secrets", "/"),
    ownRow("itx.tools", "itx.builtins.rpcStubs.get('itx.tools')", "/organizations/o"),
  ];
  const rows = await listed(
    [
      "itx ⇒ itx.builtins.cd('/')",
      "itx.browser ⇒ null",
      "itx.ai.run('b') ⇒ itx.builtins.ai.run('b')",
      "itx.kv ⇒ itx.builtins.kv",
    ],
    {
      inherit: async (path, depth) => {
        hops.push([path, depth]);
        return parentRows;
      },
    },
  );
  expect(hops).toEqual([["/", 2]]);
  expect(rows).toEqual([
    ownRow("itx", "itx.builtins.cd('/')", "/agents/a"),
    ownRow("itx.browser", null, "/agents/a"),
    ownRow("itx.ai.run('b')", "itx.builtins.ai.run('b')", "/agents/a"),
    ownRow("itx.kv", "itx.builtins.kv", "/agents/a"),
    ...CONTEXT_ROOTS.map((root) => platformRow(root, "/agents/a")),
    ownRow("itx.ai.run('gpt-5')", "itx.builtins.ai.run('gpt-5-fast')", "/"),
    ownRow("itx.repos.get", "itx.builtins.repos.get", "/", "the parent's repos"),
    platformRow("secrets", "/"),
    ownRow("itx.tools", "itx.builtins.rpcStubs.get('itx.tools')", "/organizations/o"),
  ]);
});

test("describeRewriteRules — the effective table as `rewriteRules.list()` shows it: no hop at depth 0, through a link to this context itself, or behind a bare row that is not a `cd`", async () => {
  let hopped = false;
  const inherit = async () => {
    hopped = true;
    return [];
  };
  const link = "itx ⇒ itx.builtins.cd('/')";
  expect(await listed([link], { depth: 0, inherit })).toEqual([
    ownRow("itx", "itx.builtins.cd('/')", "/agents/a"),
    ...CONTEXT_ROOTS.map((root) => platformRow(root, "/agents/a")),
  ]);
  expect(await listed(["itx ⇒ itx.builtins.cd('.')"], { inherit })).toHaveLength(
    1 + CONTEXT_ROOTS.length,
  );
  expect(await listed(["itx ⇒ itx.builtins.rpcStubs.get('everything')"], { inherit })).toHaveLength(
    1 + CONTEXT_ROOTS.length,
  );
  expect(hopped).toBe(false);
});

// ───────────────────────────── what a dead stub's un-set removes ─────────────────────────────

// When a lent stub's last pager closes, the DO un-sets every row that NAMES its key — decided against
// ONE frozen table: the rows naming the key directly, plus the rows that still resolve to it once
// those are gone. Order-independent by construction: a user's alias to a shadowed root (`itx.llm ⇒
// itx.ai` while `itx.ai` is a lent fake) survives the fake dying whichever row was configured first.
const alias = "itx.llm ⇒ itx.ai";
const fake = "itx.ai ⇒ itx.builtins.rpcStubs.get('itx.ai')";
const ownRegistry = "itx.reg ⇒ itx.builtins.rpcStubs";
const throughOwnRegistry = "itx.cam ⇒ itx.reg.get('itx.ai')";
for (const [order, rules] of [
  ["alias first", [alias, fake, ownRegistry, throughOwnRegistry]],
  ["stub first", [fake, alias, ownRegistry, throughOwnRegistry]],
] as const)
  test(`rowsNamingRpcStub — decided against a frozen table, whatever the configuration order: ${order}: the fake's own row and a row naming the key through the user's own registry go; the alias stays`, () => {
    const { ruleUnsets, subscriptionNames, fetchRouteNames } = rowsNamingRpcStub({
      rpcStubKey: "itx.ai",
      implicitRoots: ROOT,
      rules: table([...rules]),
      subscriptionTargets: {
        viaShortSpelling: parse("itx.rpcStubs.get('itx.ai')"),
        viaAlias: parse("itx.llm.notify"),
      },
      fetchRouteTargets: {
        "via-short-spelling": parse("itx.rpcStubs.get('itx.ai')"),
        "via-own-registry": parse("itx.cam"),
        "via-fake": parse("itx.ai"),
        "via-alias": parse("itx.llm"),
        elsewhere: parse("itx.kv"),
      },
    });
    expect(ruleUnsets.map((u) => print(u.match)).sort()).toEqual(["itx.ai", "itx.cam"]);
    // each unset carries the target the census saw, so the DO's removal is a compare-and-set
    expect(Object.fromEntries(ruleUnsets.map((u) => [print(u.match), print(u.ifTarget)]))).toEqual({
      "itx.ai": "itx.builtins.rpcStubs.get('itx.ai')",
      "itx.cam": "itx.reg.get('itx.ai')",
    });
    // the short spelling names the registry through the platform row and goes; the alias-spelled
    // subscription resolves to the platform `ai` beneath once the fake is gone, and stays
    expect(subscriptionNames).toEqual(["viaShortSpelling"]);
    // a route reaching the stub goes unless the table left behind still serves it: `itx.cam`
    // dangles once its rule is gone, while `itx.ai` and its alias fall to the platform `ai`
    expect(fetchRouteNames.sort()).toEqual(["via-own-registry", "via-short-spelling"]);
  });

// ───────────────────────────── the resolver, over the reduce as the DO runs it ─────────────────────────────

test("built-in resolution + default-deny: built-ins resolve directly (no rule, no config) — through the implicit platform row, or at the fixed point", async () => {
  const { invoke } = setup();
  expect(await invoke("itx.whoami()")).toEqual({ projectId: "prj_t", path: "/" });
  expect(await invoke("itx.builtins.whoami()")).toEqual({ projectId: "prj_t", path: "/" });
  expect(await invoke("itx.kv.put('a', '1')")).toEqual({ ok: true });
  expect(await invoke("itx.builtins.kv.get('a')")).toBe("1");
});

test("built-in resolution + default-deny: default-deny: no match is a readable, CODED error — under the reserved root too", async () => {
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

test("built-in resolution + default-deny: THE LAW: invoking a call equals invoking the last element of its resolution", async () => {
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

test("built-in resolution + default-deny: `invoke(call, ...args)`: live args are applied to the value the expression denotes (an `x-itx-expression` fetch's shape)", async () => {
  const { invoke } = setup();
  await invoke("itx.kv.put", "k", "v");
  expect(await invoke("itx.kv.get", "k")).toBe("v");
  expect(await invoke("itx.kv.get", "k")).toEqual(await invoke("itx.kv.get('k')"));
  expect(await invoke("itx.whoami()")).toEqual({ projectId: "prj_t", path: "/" }); // no args: the call as spelled
  expect(typeof (await invoke("itx.whoami"))).toBe("function"); // no args, no call: the value the expression denotes
});

test("built-in resolution + default-deny: `invoke(call, ...args)` folds the live args into a name-final call BEFORE resolving: a template fills from them, a pinned row and a pinned mask see them; a call-final expression applies them to the value it denotes", async () => {
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

test("built-in resolution + default-deny: even a smuggled raw event cannot reach the built-ins (a target not rooted at itx matches nothing — default-deny)", async () => {
  const { stream, invoke } = setup();
  // bypass the append boundary entirely — append the raw string-at-rest event
  stream.append({
    type: "events.iterate.com/itx/rewrite-rule-configured",
    payload: { match: "itx.evil", target: "kv" },
  });
  // the rewritten call `kv.get('a')` is denied whole — nothing not rooted at itx ever matches
  await expect(invoke("itx.evil.get('a')")).rejects.toThrow(/no rewrite rule matches "kv\.get/);
});

test("built-in resolution + default-deny: a malformed raw payload is skipped by the reduce, never wedging later resolves", async () => {
  const { stream, invoke } = setup();
  stream.append({
    type: "events.iterate.com/itx/rewrite-rule-configured",
    payload: { match: "itx.broken(", target: "itx.kv" },
  });
  // the table still answers — the bad rule simply doesn't exist
  expect(await invoke("itx.whoami()")).toEqual({ projectId: "prj_t", path: "/" });
  await expect(invoke("itx.broken.x()")).rejects.toThrow(/no rewrite rule matches/);
});

test("built-in resolution + default-deny: a hand-built call step at the scope root is refused by the codec — the ARRAY half reads like the string half (`itx(1)` never parses), before any rule is consulted", async () => {
  const { invoke } = setup();
  await expect(invoke([["itx", 1]])).rejects.toThrow(/a call on the root itself/);
});

test("the rule table — a MAP by match: set replaces, null masks or deletes, the platform-equivalent target restores: ⚠️ a self-referential rule errors at depth, never spins", async () => {
  const { rewrite, invoke } = setup();
  rewrite("itx.loop", "itx.loop");
  await expect(invoke("itx.loop.go()")).rejects.toThrow(/depth 32/);
});

test("the rule table — a MAP by match: set replaces, null masks or deletes, the platform-equivalent target restores: a rule targeting another rule: the target rewrites one level deeper, the steps after the match replay on it", async () => {
  const { rewrite, invoke } = setup();
  rewrite("itx.db", "itx.kv");
  await invoke("itx.db.put('k', 'v')");
  expect(await invoke("itx.kv.get('k')")).toBe("v"); // same underlying kv — the rules composed
});

test("the rule table — a MAP by match: set replaces, null masks or deletes, the platform-equivalent target restores: a longer match under the target's prefix CAPTURES the deeper call — a rule rewrites the call, it does not bind a value", async () => {
  const { rewrite, invoke } = setup();
  rewrite("itx.store", "itx.kv");
  rewrite("itx.store.deep", "itx.whoami"); // longer than `itx.store`: wins for `.deep`
  rewrite("itx.db", "itx.store");
  // `itx.db.deep()` rewrites to `itx.store.deep()`, which the longer match claims — never a walk on
  // the kv value's (non-existent) `deep`.
  expect(await invoke("itx.db.deep()")).toEqual(await invoke("itx.whoami()"));
  expect(await invoke("itx.db.get('missing')")).toBeNull(); // the shorter match still reaches kv
});

test("the rule table — a MAP by match: set replaces, null masks or deletes, the platform-equivalent target restores: MISHA'S TEST: a rule at a built-in's name SHADOWS it; removing the rule gives the real one back; the physical spelling never moved", async () => {
  const { provide, invoke, remove, rewriteRules } = setup();
  provide("itx.whoami", () => ({ projectId: "fake", path: "/fake" }));
  expect(await invoke("itx.whoami()")).toEqual({ projectId: "fake", path: "/fake" });
  expect(await invoke("itx.builtins.whoami()")).toEqual({ projectId: "prj_t", path: "/" });
  remove("itx.whoami"); // what a disposed handle / a dead stub appends
  expect(await invoke("itx.whoami()")).toEqual({ projectId: "prj_t", path: "/" });
  expect(rewriteRules().some((rule) => print(rule.match) === "itx.whoami")).toBe(false);
});

test("the rule table — a MAP by match: set replaces, null masks or deletes, the platform-equivalent target restores: a MASK: `null` at a built-in's name is KEPT as a row and refuses the call; the removal spelling lifts it; `null` elsewhere simply deletes", async () => {
  const { rewrite, remove, invoke, rewriteRules, events } = setup();
  rewrite("itx.kv", null);
  expect(rewriteRules().find((rule) => print(rule.match) === "itx.kv")?.target).toBeNull();
  await expect(invoke("itx.kv.put('a', '1')")).rejects.toMatchObject({
    code: "NO_ITX_EXPRESSION_MATCH",
    message: expect.stringMatching(/is masked/),
  });
  expect(await invoke("itx.builtins.kv.put('a', '1')")).toEqual({ ok: true }); // the physical scope still answers
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

test("the rule table — a MAP by match: set replaces, null masks or deletes, the platform-equivalent target restores: a PARTIAL mask under a built-in root refuses only what it claims", async () => {
  const { rewrite, invoke } = setup();
  rewrite("itx.kv.get", null);
  expect(await invoke("itx.kv.put('a', '1')")).toEqual({ ok: true });
  await expect(invoke("itx.kv.get('a')")).rejects.toThrow(/is masked/);
  rewrite("itx.kv.get", "itx.kv.put"); // a target replaces the mask
  expect(await invoke("itx.kv.get('b', '2')")).toEqual({ ok: true });
});

test("the rule table — a MAP by match: set replaces, null masks or deletes, the platform-equivalent target restores: a provided stub is an ordinary rule whose target names the PHYSICAL registry — pure data, nothing about the socket", () => {
  const { events, provide } = setup();
  provide("itx.cam", { shot: () => "frame" });
  expect(events.at(-1)!).toMatchObject({
    payload: {
      match: ["itx", "cam"],
      target: ["itx", "builtins", "rpcStubs", ["get", "itx.cam"]],
    },
  });
});

test("the rule table — a MAP by match: set replaces, null masks or deletes, the platform-equivalent target restores: LONGEST MATCH WINS at resolve: a deeper rule takes the calls under it, the shorter keeps the rest", async () => {
  const { provide, rewrite, invoke } = setup();
  provide("itx.wide", { f: () => "wide", deep: { f: () => "wide's deep" } });
  provide("itx.narrow", { f: () => "narrow" });
  rewrite("itx.a", "itx.wide");
  rewrite("itx.a.deep", "itx.narrow");
  expect(await invoke("itx.a.deep.f()")).toBe("narrow");
  expect(await invoke("itx.a.f()")).toBe("wide");
});

test("the rule table — a MAP by match: set replaces, null masks or deletes, the platform-equivalent target restores: a re-set REPLACES the rule at that match; `null` DELETES it (nothing beneath); setting the old target back restores it (no stack)", async () => {
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

test("the rule table — a MAP by match: set replaces, null masks or deletes, the platform-equivalent target restores: the rule is data, the stub is physical: re-lending serves the same rule, the log is untouched; un-setting the rule → default-deny while presence stays", async () => {
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

test("the rule table — a MAP by match: set replaces, null masks or deletes, the platform-equivalent target restores: args at the match: a call at the match itself applies the rewritten target", async () => {
  const { rewrite, invoke, builtIns } = setup();
  rewrite("itx.grok", "itx.ai.chat");
  expect(await invoke("itx.grok({ model: 'grok-4' })")).toBe("chat:grok-4");
  expect(builtIns.aiCalls[0]).toEqual({ model: "grok-4" });
});

test("the rule table — a MAP by match: set replaces, null masks or deletes, the platform-equivalent target restores: THE DREAM, through the reduce: `itx.fable ⇒ itx.ai.run('@cf/…', @)` is one row at rest; the caller's inputs fill `@`; `...@` pins a gateway model", async () => {
  const { rewrite, invoke, resolve, events } = setup();
  rewrite("itx.fable", "itx.ai.run('@cf/meta/llama-3.2-1b-instruct', @)");
  expect(events.at(-1)!).toMatchObject({
    payload: {
      match: ["itx", "fable"],
      target: ["itx", "ai", ["run", "@cf/meta/llama-3.2-1b-instruct", { "@": true }]], // `@` at rest is the reserved literal
    },
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

test("the rule table — a MAP by match: set replaces, null masks or deletes, the platform-equivalent target restores: A BARE `itx` ROW WITH A TARGET: a lent stub there catches every name no implicit row claims — at the owner root only unknown names; the built-ins stay the context's own", async () => {
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
  expect(await invoke("itx.whoami()")).toEqual({ projectId: "prj_t", path: "/" }); // implicit outranks the bare row
  expect(await invoke("itx.builtins.whoami()")).toEqual({ projectId: "prj_t", path: "/" });
  remove("itx"); // `itx ⇒ itx.builtins` at the owner root restates the default: the row is gone
  await expect(invoke("itx.anything('x')")).rejects.toThrow(/no rewrite rule matches/);
});

test("the rule table — a MAP by match: set replaces, null masks or deletes, the platform-equivalent target restores: A BARE `itx ⇒ null` DENIES ALL — one row is a jail, the context's own roots included; a longer row still grants through it", async () => {
  const { invoke, rewrite } = setup();
  rewrite("itx", null);
  await expect(invoke("itx.whoami()")).rejects.toThrow(/is masked/);
  await expect(invoke("itx.append({ type: 't' })")).rejects.toThrow(/is masked/);
  await expect(invoke("itx.anything('x')")).rejects.toThrow(/is masked/);
  expect(await invoke("itx.builtins.whoami()")).toEqual({ projectId: "prj_t", path: "/" }); // the physical scope is the kernel's
  rewrite("itx.whoami", "itx.builtins.whoami"); // a grant through the wall
  expect(await invoke("itx.whoami()")).toEqual({ projectId: "prj_t", path: "/" });
  await expect(invoke("itx.append({ type: 't' })")).rejects.toThrow(/is masked/);
});

test("the rule table — a MAP by match: set replaces, null masks or deletes, the platform-equivalent target restores: a rule to a key nothing is lent under answers offline until the rule is un-set — the table never auto-unsets", async () => {
  const { rewrite, invoke, rewriteRules, provide, _recall } = setup();
  provide("itx.robot", { move: (n: unknown) => `moved ${n}` });
  expect(await invoke("itx.robot.move(10)")).toBe("moved 10");
  _recall("itx.robot");
  await expect(invoke("itx.robot.move(10)")).rejects.toThrow(/offline/);
  expect(rewriteRules().some((rule) => print(rule.match) === "itx.robot")).toBe(true);
  rewrite("itx.robot", null);
  await expect(invoke("itx.robot.move(10)")).rejects.toThrow(/no rewrite rule matches/);
});

test("the rule table — a MAP by match: set replaces, null masks or deletes, the platform-equivalent target restores: un-setting a match with no rule is a no-op — the event lands, the table still resolves", async () => {
  const { rewrite, invoke, events } = setup();
  rewrite("itx.never", null);
  expect(events).toHaveLength(1); // the event lands; the reduce keeps the state
  expect(await invoke("itx.kv.put('a', '1')")).toEqual({ ok: true });
  expect(await invoke("itx.kv.get('a')")).toBe("1");
});

test("targets round-trip the codec: rewrite → print → reduce → parse: a target with a large number literal rewrites (print renders 1e21 as 1e+21; the parser reads the exponent)", async () => {
  const { rewrite, invoke, provide } = setup();
  provide("itx.c", { echo: (n: unknown) => `echo:${n}` });
  rewrite("itx.big", ["itx", "c", ["echo", 1e21]]);
  expect(await invoke("itx.big")).toBe(`echo:${1e21}`); // the target is a complete call
});

test("targets round-trip the codec: rewrite → print → reduce → parse: a target with a non-identifier object key rewrites (print QUOTES the key; the parser re-reads it)", async () => {
  const { rewrite, invoke } = setup();
  rewrite("itx.chat", ["itx", "ai", ["chat", { "a b": "grok-4" }]]);
  // ai.chat reads o.model (absent here) → "chat:undefined"; the point is it REWRITES at all.
  expect(await invoke("itx.chat")).toBe("chat:undefined");
});

test("the app wall (`Caller.app`): on the INPUT expression only, `itx.builtins` is refused and `cd` goes down only — from the root too: at the root, every project path is a descendant: `cd('/x')` and `cd('./x')` pass, `cd('.')` is self; `itx.builtins` is refused", () => {
  const resolver = appResolverAt("/", ROOT);
  expect(() => resolver.resolve("itx.cd('/x').whoami()")).not.toThrow();
  expect(() => resolver.resolve("itx.cd('./x').cd('y').whoami()")).not.toThrow();
  expect(() => resolver.resolve("itx.cd('.').whoami()")).not.toThrow();
  expect(() => resolver.resolve("itx.builtins.whoami()")).toThrow(/not a loaded worker's word/);
});
test("the app wall (`Caller.app`): on the INPUT expression only, `itx.builtins` is refused and `cd` goes down only — from the root too: at a child, `cd` may not leave it: `/`, `..`, a sibling — refused; its own descendants pass; a `cd` that steps down then up past the base is refused", () => {
  const resolver = appResolverAt("/agents/a", CHILD);
  expect(() => resolver.resolve("itx.cd('./b').whoami()")).not.toThrow();
  expect(() => resolver.resolve("itx.cd('/agents/a/b/c').whoami()")).not.toThrow();
  for (const to of ["/", "..", "/agents/b", "../a2", "/agents/ab"])
    expect(() => resolver.resolve(`itx.cd('${to}').whoami()`)).toThrow(/goes down only/);
  expect(() => resolver.resolve("itx.cd('./b').cd('../..').whoami()")).toThrow(/goes down only/);
});
test("the app wall (`Caller.app`): on the INPUT expression only, `itx.builtins` is refused and `cd` goes down only — from the root too: a ROW loaded code appends is walled on its target: the fixed point and a cd above are refused, its own lend (`itx.builtins.rpcStubs.get`) and a plain expression pass, a mask says nothing", () => {
  const row = (type: string, target: unknown) => () =>
    admitLoadedCodeRow({ type, payload: { match: "itx.x", target } }, "/agents/a");
  expect(row("events.iterate.com/itx/rewrite-rule-configured", "itx.builtins.cd('/')")).toThrow(
    /not a loaded worker's word/,
  );
  expect(row("events.iterate.com/itx/rewrite-rule-configured", "itx.builtins.kv")).toThrow(
    /not a loaded worker's word/,
  );
  expect(row("events.iterate.com/itx/rewrite-rule-configured", "itx.cd('..').whoami")).toThrow(
    /goes down only/,
  );
  expect(
    row("events.iterate.com/itx/subscription-configured", "itx.builtins.cd('/').append"),
  ).toThrow(/not a loaded worker's word/);
  expect(
    row("events.iterate.com/itx/rewrite-rule-configured", "itx.builtins.rpcStubs.get('itx.x')"),
  ).not.toThrow();
  expect(
    row("events.iterate.com/itx/subscription-configured", [
      "itx",
      "builtins",
      "rpcStubs",
      ["get", "subscription:s"],
    ]),
  ).not.toThrow();
  expect(row("events.iterate.com/itx/rewrite-rule-configured", "itx.whoami")).not.toThrow();
  expect(
    row("events.iterate.com/itx/rewrite-rule-configured", "itx.cd('./b').whoami"),
  ).not.toThrow();
  expect(row("events.iterate.com/itx/rewrite-rule-configured", null)).not.toThrow();
  expect(row("events.iterate.com/note/added", "itx.builtins.cd('/')")).not.toThrow(); // not a row
});
// A SOURCE PRODUCER runs at the host as the context itself when the code loads, so it is walled like
// the call around it, at the context the walk has reached: in a call's spec and in a row's target.
const PRODUCER_ROWS: { name: string; call: string; refused?: RegExp }[] = [
  {
    name: "the config repo's modules: passes",
    call: "itx.workers.get({ source: \"itx.repos.get('/repos/config').modules()\", cacheKey: 'k' }).run()",
  },
  {
    name: "a descendant's kv, from a descendant: passes",
    call: "itx.cd('./b').workers.get({ source: \"itx.cd('./c').kv.get('src')\", cacheKey: 'k' }).run()",
  },
  {
    name: "the fixed point in a worker's producer: refused",
    call: "itx.workers.get({ source: \"itx.builtins.cd('/').append({ type: 'x' })\", cacheKey: 'k' }).run()",
    refused: /not a loaded worker's word/,
  },
  {
    name: "a cd to the root in a facet's producer: refused",
    call: "itx.facets.get('f', { source: \"itx.cd('/').append({ type: 'x' })\", className: 'F', cacheKey: 'k' }).x()",
    refused: /goes down only/,
  },
  {
    name: "a cd up in a processor's producer: refused",
    call: "itx.processors.enable('p', { source: \"itx.cd('..').kv.get('src')\", className: 'P', cacheKey: 'k' })",
    refused: /goes down only/,
  },
  {
    name: "walled where the walk has reached: a descendant's producer may not name its base",
    call: "itx.cd('./b').workers.get({ source: \"itx.cd('/agents/a').kv.get('src')\", cacheKey: 'k' }).run()",
    refused: /goes down only/,
  },
];
test.for(PRODUCER_ROWS)("the app wall walls a source producer: $name", ({ call, refused }) => {
  const resolve = () => appResolverAt("/agents/a", CHILD).resolve(call);
  if (refused) expect(resolve).toThrow(refused);
  else expect(resolve).not.toThrow();
});
test("the app wall on a row walls the source producer in its target too", () => {
  const row = (source: string) => () =>
    admitLoadedCodeRow(
      {
        type: "events.iterate.com/itx/subscription-configured",
        payload: {
          name: "p",
          target: [
            "itx",
            "facets",
            ["get", "p", { source, className: "P", cacheKey: "k" }],
            "processEventBatch",
          ],
        },
      },
      "/agents/a",
    );
  expect(row("itx.builtins.cd('/').kv.get('src')")).toThrow(/not a loaded worker's word/);
  expect(row("itx.kv.get('src')")).not.toThrow();
});
test("the app wall (`Caller.app`): on the INPUT expression only, `itx.builtins` is refused and `cd` goes down only — from the root too: a row has no way round the wall: loaded code removes no row (`ifTarget`, null or not), a scheduled batch is walled event by event as it is scheduled, and a fetch route is set only from the project's root", () => {
  const append =
    (event: { type: string; payload?: unknown }, base = "/agents/a") =>
    () =>
      admitLoadedCodeRow(event, base);
  for (const ifTarget of [null, "itx.cd('./b').tool"])
    expect(
      append({
        type: "events.iterate.com/itx/rewrite-rule-configured",
        payload: { match: "itx.tool", target: null, ifTarget },
      }),
    ).toThrow(/removes no row/);
  const schedule = (events: { type: string; payload?: unknown }[]) => ({
    type: "events.iterate.com/itx/schedule-set",
    payload: { key: "k", when: { afterMs: 0 }, events },
  });
  const rewrite = (target: string) => ({
    type: "events.iterate.com/itx/rewrite-rule-configured",
    payload: { match: "itx.tool", target },
  });
  expect(append(schedule([rewrite("itx.builtins.cd('/').tool")]))).toThrow(
    /not a loaded worker's word/,
  );
  expect(
    append(schedule([{ type: "events.iterate.com/note/added" }, rewrite("itx.cd('..').tool")])),
  ).toThrow(/goes down only/);
  expect(
    append(schedule([{ type: "events.iterate.com/note/added" }, rewrite("itx.cd('./b').tool")])),
  ).not.toThrow();
  const route = {
    type: "events.iterate.com/itx/fetch-route-configured",
    payload: {
      fetchRouteName: "leak",
      requestMatcher: { routingSlug: "leak" },
      target: "itx.tool",
    },
  };
  expect(append(route)).toThrow(/set only from the project's root/);
  expect(append(schedule([route]))).toThrow(/set only from the project's root/);
  expect(append(route, "/")).not.toThrow();
});

test("cd forwards a factory and terminal fetch together, without exporting an intermediate handle over RPC", async () => {
  const request = new Request("https://provider.example/", { headers: { upgrade: "websocket" } });
  const received: ItxExpression[] = [];
  const resolver = new ItxExpressionResolver({
    builtIns: {
      cd: () =>
        new InvokeHandle((steps) => {
          received.push(steps);
          return new Response("native fetch");
        }),
    },
    rewriteRules: () =>
      table([
        "itx.provider ⇒ itx.builtins.cd('/provider').workers.get({source:{'worker.js':'source'}})",
      ]),
    implicitRoots: ROOT,
    path: "/",
    caller: () => ({ principal: null }),
  });
  const response = (await resolver.invoke("itx.provider.fetch", request)) as Response;
  expect(await response.text()).toBe("native fetch");
  expect(received).toEqual([
    ["workers", ["get", { source: { "worker.js": "source" } }], ["fetch", request]],
  ]);
});

/** The platform-equivalent target of a match: at the owner root, where these tests run, a
 *  deletion (the core reduce's un-set) — the spelling a client may still use to un-set a row it wrote. */
const restoreRuleTarget = (match: ItxExpressionInput): ItxExpression => [
  "itx",
  "builtins",
  ...parseItxExpressionPrefix(match).slice(1),
];

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
    return resolveItxExpression(() => table(rules), parse(call), ROOT).map((step) => print(step));
  } catch (error) {
    return `THROWS ${(error as Error).message}`;
  }
};

/** The call that runs (the chain's last element), printed — or the refusal. */
const runs = (rules: string[], call: string): string => {
  const c = chain(rules, call);
  return typeof c === "string" ? c : c.at(-1)!;
};

const platformRow = (root: string, context: string): RewriteRuleListEntry => ({
  match: `itx.${root}`,
  target: `itx.builtins.${root}`,
  description: BUILT_IN_ROOT_DESCRIPTIONS[root as keyof typeof BUILT_IN_ROOT_DESCRIPTIONS],
  context,
});

const ownRow = (
  match: string,
  target: string | null,
  context: string,
  description?: string,
): RewriteRuleListEntry => ({ match, target, description, context });

/** The list at `path` over these rows; `inherit` answers the hop (none by default). */
const listed = (
  rows: string[],
  options: {
    path?: string;
    implicitRoots?: ReadonlySet<string>;
    depth?: number;
    inherit?: (path: string, depth: number) => Promise<RewriteRuleListEntry[]>;
  } = {},
) =>
  describeRewriteRules({
    rules: table(rows),
    implicitRoots: options.implicitRoots || CHILD,
    path: options.path || "/agents/a",
    depth: options.depth ?? 3,
    inherit: options.inherit || (async () => []),
  });

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
  const { stream, events } = nodeSqliteStream();
  const builtIns = fakeBuiltIns();
  // The rules are the real Stream's core state, as the DO reads them: a malformed control event is
  // skipped (reported) by Stream.#reduceEventsIntoCoreReducedState, never wedging the stream.
  const rewriteRules = () => Object.values(stream.coreReducedState.itxExpressionRewriteRules);
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
  const resolver = new ItxExpressionResolver({
    builtIns: { ...builtIns, rpcStubs },
    rewriteRules,
    implicitRoots: ROOT,
    path: "/",
    caller: () => ({ principal: null }),
  });
  /** The edge's `provide(match, expression | null)`: build the ONE event, append it. A refusal throws
   *  at the append boundary — nothing is appended. */
  const rewrite = (match: ItxExpressionInput, target: ItxExpressionInput | null) =>
    stream.append(
      normalizeControlEvent(
        {
          type: "events.iterate.com/itx/rewrite-rule-configured",
          payload: { match: match, target: target },
        },
        "/",
      ),
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
      stream.append(
        normalizeControlEvent(
          {
            type: "events.iterate.com/itx/rewrite-rule-configured",
            payload: { match: match, target: restoreRuleTarget(match) },
          },
          "/",
        ),
      )[0],
    provide,
    _lend: (rpcStubKey: string, stub: unknown) => lentRpcStubs.set(rpcStubKey, stub),
    _recall: (rpcStubKey: string) => lentRpcStubs.delete(rpcStubKey),
  };
};

const appResolverAt = (path: string, implicitRoots: ReadonlySet<string>) =>
  new ItxExpressionResolver({
    builtIns: fakeBuiltIns(),
    rewriteRules: () => [],
    implicitRoots,
    path,
    caller: () => ({ principal: null, app: true }),
  });
