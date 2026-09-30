# Sweep candidates: os-context-routing

Verified candidates from the 2026-09-29 codebase simplification sweep for this area. Each passed an adversarial skeptic check; where the skeptic amended the proposal, the amendment wins. Line numbers are as of origin/main on 2026-09-29 (about cfd8a1d36) and have drifted since: #3442, #3455 and #3460 touched some of these files. The index and the owner calls are in ../codebase-simplification-sweep.md.

## One `fixedPointOf` for 'resolve, or nothing', instead of six try/catch wrappers and three spellings of the lend target

- Sweep index: 17; risk: low; payoff: 3/10
- LOC: About −35 net. The existing spans total 78 lines: itx-expression-rewriting.ts (7+8+30+9+8+2) and core-processor.ts (14). They become about 30 lines, plus a 12-line helper. (skeptic measured: git diff --no-index on an oxfmt-formatted scratch copy:
- apps/os/src/context/itx-expression-rewriting.ts: 1240 → 1215 (+32/−57)
- apps/os/src/stream/core-processor.ts: 823 → 819 (+6/−10)
- Net −29 across 2 files.

Scratch copy: /private/tmp/claude-501/-Users-jonastemplestein--herdr-worktrees-iterate-first-party-agents/8c90908e-f48e-4f3f-adc0-08a3364e1b4c/scratchpad/wt-fp. `tsc --noEmit -p apps/os` exits 0, and the 3 pinning test files pass (289 tests).)

- Concepts: 6 resolve-or-nothing wrappers and 3 lend recognisers become 1 of each.

### Evidence

There are six try/catch wrappers around resolveItxExpression.

In context/itx-expression-rewriting.ts:

- :493-499 `answered`
- :570-579 `namesThroughRemaining`
- :583-589 `resolvedThrough`
- :830-838 rpcStubKeysNamed
- :885-892 describeRewriteRules

In stream/core-processor.ts:

- :129-142 `resolveThroughState`

There are three recognisers of `itx.builtins.rpcStubs.get(k)`:

- namesRpcStubDirectly at :534-539
- builtInsGetStep at :799
- an inline tuple check at :743-745

These three differ on extra args and on whether the key must be a string.

### Current shape

Every caller that wants to know where a target ends up wraps the resolver in its own try/catch and takes `.at(-1)`. rowsNamingRpcStub alone does this twice, under two names. Some wrappers swallow only NO_ITX_EXPRESSION_MATCH; the others swallow every error.

### Proposed shape

```ts
export function fixedPointOf(
  rules: readonly ItxExpressionRewriteRule[],
  call: ItxExpression,
  implicitRoots: ReadonlySet<string>,
) {
  try {
    return resolveItxExpression(() => rules, call, implicitRoots).at(-1);
  } catch {
    return undefined;
  }
}
const lentKeyOf = (t?: ItxExpression | null) =>
  t ? builtInsGetStep(t, "rpcStubs")?.[1] : undefined;
```

The six wrappers and three recognisers become calls to these two functions. core-processor's resolveThroughState becomes a one-liner.

### What changes

- rewriteRules.list(): a bare link that trips the depth budget now lists its rows. Today it throws the depth error.
- `rpcStubs.get(k, extra)` now counts as naming k.
- A loaded-code row targeting `rpcStubs.get(<non-string>)` is now walled FORBIDDEN instead of passing.
- Everything else is identical.

### Pinned by

- src/context/itx-expression-rewriting.test.ts:712-819, :820-860 and :1197-1230
- rule-snapshots.test.ts
- stream/core-processor.test.ts

### Skeptic's amended proposal

Add one function to itx-expression-rewriting.ts, next to `resolveItxExpression`. It keeps the THUNK, so a target that is already rooted at builtins never materializes the table:

```ts
/** Where `call` ends up — the fixed point — or undefined when it cannot resolve right now (a name
 *  nothing claims, a mask, the depth budget). */
export function fixedPointOf(
  rules: () => readonly ItxExpressionRewriteRule[],
  call: ItxExpression,
  implicitRoots: ReadonlySet<string>,
): ItxExpression | undefined {
  try {
    return resolveItxExpression(rules, call, implicitRoots).at(-1);
  } catch {
    return undefined;
  }
}
```

Do NOT add `lentKeyOf`. Delete `namesRpcStubDirectly` (:532-539). Inside `rowsNamingRpcStub`:

```ts
const names = (t: ItxExpression | null | undefined) =>
  !!t && builtInsGetStep(t, "rpcStubs")?.[1] === rpcStubKey;
const through = (table: readonly ItxExpressionRewriteRule[], t: ItxExpression) =>
  fixedPointOf(() => table, t, implicitRoots);
const direct = rules.filter((rule) => names(rule.target));
const namesThroughRemaining = (t: ItxExpression) => names(through(remaining, t));
const reachesOnlyRpcStub = (t: ItxExpression) => {
  if (!names(through(rules, t))) return false;
  const afterwards = through(survivingRules, t);
  return !afterwards || names(afterwards);
};
```

The other call sites:

- `answered`: `!!fixedPointOf(() => rulesBefore, match, implicitRoots)`.
- `rpcStubKeysNamed` loop: `const resolved = fixedPointOf(...); const getStep = resolved && builtInsGetStep(resolved, "rpcStubs"); if (getStep) keys.add(getStep[1]);`.
- `describeRewriteRules`: `const target = fixedPointOf(() => rules, bare.target, implicitRoots); if (!target) return rows;`.
- `admitLoadedCodeRow`: `if (builtInsGetStep(expression, "rpcStubs")) return;`.
- core-processor `resolveThroughState`: `return fixedPointOf(() => Object.values(state.itxExpressionRewriteRules), target, implicitRootsAt(...))`, and the `resolveItxExpression` import becomes `fixedPointOf`.

What changes, and nothing else does:

1. `rewriteRules.list()` lists rows instead of throwing when the bare link hits the depth budget or a hole-arity error.
2. A row naming `rpcStubs.get('k', extra)` now goes with stub k. That matches the wake census, which already counted it.
3. Loaded code can no longer write a lend row whose key is not a string: `get()`, `get(@)` or `get(1)` are now walled.

The PR description should say that the one-row census/removal mismatch is fixed.

### Skeptic's verdict

The claim holds, but the win is smaller than the candidate says. I applied the rewrite to a scratch copy of origin/main at b3daf4846, which already contains #3446 (it merged, and it does not touch these spans). With the rewrite, `tsc --noEmit -p apps/os` passes. The three pinning files also pass: itx-expression-rewriting.test.ts, rule-snapshots.test.ts and core-processor.test.ts, 289 tests.

(a) Semantics, wrapper by wrapper:

- Four wrappers are identical after the change: `answered`, `namesThroughRemaining`, `resolvedThrough` (null vs undefined, only ever tested with `!`) and core-processor's `resolveThroughState`. Each already swallowed every error.
- `rpcStubKeysNamed` is also identical.
- `describeRewriteRules` (:886-892) is the one that changes. Today it rethrows anything that is not NO_ITX_EXPRESSION_MATCH, so `rewriteRules.list()` throws in two cases:
  - A bare link trips the depth budget. The rule in test :274, `itx ⇒ itx.cam.get('itx')`, is one example.
  - A `@` gets the wrong number of arguments.
    After the change, `list()` returns the own rows plus the implicit rows. No unit or e2e test pins the throw. For a listing this is arguably better: you can see the broken row.

Lend recognisers:

- `namesRpcStubDirectly` compares with jsonEqual against exactly `["get", key]`. `builtInsGetStep` accepts extra arguments. These have drifted apart, and the drift is a real mismatch:
  - The wake census (`rpcStubKeysNamed`, which uses `builtInsGetStep`) counts `rpcStubs.get('k', x)` as naming k.
  - `rowsNamingRpcStub` never removes that row.
  - So each wake re-fires `#unsetWhatNamesRpcStub(k)` as a no-op.
    Unifying on `builtInsGetStep` removes that row together with its stub. That matches the docstring ("every rule and row whose target RESOLVES to …get('<key>')"). `get` takes only one argument, and nothing writes extra arguments.
- The inline check in `admitLoadedCodeRow` (:743-745) lets through `get()`, `get(@)` (a hole is the object `{"@":true}`) and `get(1)`. With `builtInsGetStep` all three are now walled "not a loaded worker's word". This tightens a security wall. The only writers are iterate-context.ts:380 and :457, and both write a string key. Test :1210-1219 uses string keys and still passes.
- Both `namesRpcStubDirectly` and the inline check also look at `target[0]`/`[1]`. Any resolved fixed point or parsed target already starts with `itx`, so `builtInsGetStep` not checking `[0]` changes nothing.

(b) The new shape is really simpler, not a lateral move:

- Six try/catch blocks with four different error conventions (false, null, undefined, rethrow-unless-NO_MATCH) become one function. docs/jonasland-rules.md says "Do not over-use try/catch".
- Three lend recognisers become one. `builtInsGetStep` is already exported and already used by core-processor.
- `namesRpcStubDirectly` is deleted.
- The name `fixedPointOf` uses the file's own vocabulary ("the fixed point", the local `fixedPoint`), so it adds no new concept.

(c) No guarantee is dropped:

- Loop limits still hold: the depth budget still throws everywhere a call is dispatched, and only three read-only paths swallow it (the listing, the census and the reduce's classification). The reduce's classification swallowed it already.
- The compare-and-set `ifTarget` removal is unchanged.
- The app wall only gets stricter.

(d) LOC, re-measured on the oxfmt-formatted scratch copy with `git diff --no-index`:

- itx-expression-rewriting.ts: 1240 → 1215 (+32/−57).
- core-processor.ts: 823 → 819 (+6/−10).
- Net −29, not the claimed −35.

The spec needed two fixes:

- `fixedPointOf` must keep the rules thunk that `resolveItxExpression` takes. With an eager array, core-processor's `targetOwnsProgress` and `targetIsWebhook` would run `Object.values` on every row, which breaks the rule that "a fixed-point dispatch never materializes the table".
- The proposed `lentKeyOf` export is unnecessary. A local `names` closure over `builtInsGetStep` covers it.

Payoff is modest (3). This is a real cleanup of a drifted duplicate in the routing core, but it removes about 30 lines, not heavy junk.

## Drop the append-time self-link refusal: the resolver's 16-context hop limit already refuses that loop

- Sweep index: 18; risk: low; payoff: 4/10
- LOC: About −58 net (−62/+4).
- itx-expression-rewriting.ts: −20
- core-processor.ts: −3
- test: −39, +4 (skeptic measured: Measured on a scratch copy of origin/main with the amended change applied, after oxfmt. Totals are +204/−378, net −174, across 11 files.

**Production, −25:**

- itx-expression-rewriting.ts: 1240 → 1220
- core-processor.ts: 823 → 820
- iterate-context-durable-object.ts: 1934 → 1932
- app-config.ts: 641 → 641

**Tests, −149:**

- itx-expression-rewriting.test.ts: 1816 → 1754
- core-processor.test.ts: 1487 → 1457
- scheduled-appends.test.ts: 407 → 383
- memory-budget.test-support.ts: 826 → 808
- subscription-delivery.test.ts: 2459 → 2456
- e2e/rewrite-rules.e2e.test.ts: 442 → 430
- processor.test.ts: ±0

**The candidate's narrower scope** (keeping `ownPath`, but adding the e2e deletion the candidate missed) comes to about −72 net: production −23, tests −49.)

- Concepts: 2 routing-loop guards become 1, the hop count.

### Evidence

- apps/os/src/context/itx-expression-rewriting.ts:776-795 `refuseSelfLoopRow` justifies itself as guarding 'a loop no depth budget can see — every hop is a fresh resolve'.
- Its caller, stream/core-processor.ts:818-819, gives the same reason: 'The one row no table can refuse at resolve'.
- That reason has expired. Since #3425 (09-29), `ItxExpressionResolver#route` (itx-expression-rewriting.ts:1137-1181) calls `crossingOneMore` (cause.ts:117, MAX_CONTEXT_HOPS = 16) for every `cd` it follows.
- cause.ts:1 describes itself as 'THE LOOP GUARD, explained here and nowhere else'.
- The listing at itx-expression-rewriting.ts:906 already treats a link to the row's own path as no link.
- Platform code never writes a self-link (library.ts `entityRoot` links point up).

### Current shape

A bare `itx` row whose target `cd`s back to its own context is refused at append time, including inside schedule batches. The refusal is a special case that parses the target's cd step and compares paths. The resolver separately refuses every routing loop, this one included, by counting hops.

### Proposed shape

- Delete `refuseSelfLoopRow` and its call site.
- Delete the append-refusal test at itx-expression-rewriting.test.ts:670-708.
- Extend the existing hop-limit row with a self-link case:

```ts
test.for([
  { own: ["itx.loop ⇒ itx.cd('/b').loop"], others: { '/b': ["itx.loop ⇒ itx.cd('/a').loop"] } },
  { own: ["itx ⇒ itx.cd('.')"], others: {} },
])('rows that lead back into each other are refused after 16 contexts', ...)
```

### What changes

- The row is accepted at append instead of refused.
- A call through it, for a name that is not an implicit root there, fails at resolve with the hop-limit message after 16 in-memory hops.
- Context roots still resolve locally: a bare link yields to implicit rows.
- The misconfiguration is reported when the row is used, not when it is written.

### Pinned by

- itx-expression-rewriting.test.ts:670, which is deleted
- itx-expression-rewriting.test.ts:1604, which is extended
- **workers-tests**/loop-guard.test.ts:386-410 and :508

### Skeptic's amended proposal

One PR that removes the append-time self-link refusal and the `ownPath` parameter it was the only user of. The hop count (cause.ts `crossingOneMore`, called from `#route`) becomes the only routing-loop guard.

**Production code:**

- itx-expression-rewriting.ts: delete `refuseSelfLoopRow` (the doc comment and the function, lines 776-794, 20 lines).
- core-processor.ts:
  - drop its import (line 62);
  - drop the comment and the call (lines 818-819);
  - change the signature to `export function normalizeControlEvent(event: StreamEventInput): StreamEventInput`;
  - change the schedule-batch recursion (line 782) to `payload.events.map((scheduled) => normalizeControlEvent(scheduled))`.
- iterate-context-durable-object.ts:779-781 becomes `const normalized = events.map((event) => normalizeControlEvent(event));`.
- app-config.ts:411 becomes `normalizeControlEvent(event)`.

**Tests:**

- Drop the second argument at every call site in core-processor.test.ts, scheduled-appends.test.ts, memory-budget.test-support.ts, subscription-delivery.test.ts, processor.test.ts and itx-expression-rewriting.test.ts. oxfmt then collapses most of them.
- Delete itx-expression-rewriting.test.ts:670-709, the append-refusal test.
- Delete e2e/rewrite-rules.e2e.test.ts:268-279, and trim the header bullet at line 17 to end at "the context's own log stays its own)".
- Extend the hop-limit row:

```ts
test.for<{ own: string[]; others: Record<string, string[]> }>([
  { own: ["itx.loop ⇒ itx.cd('/b').loop"], others: { "/b": ["itx.loop ⇒ itx.cd('/a').loop"] } },
  { own: ["itx ⇒ itx.cd('.')"], others: {} },
])(
  "rows that cd into each other, or a bare row into its own context, are refused after a bounded number of contexts, not followed forever",
  async ({ own, others }) => {
    const { resolver } = acrossContexts({ at: "/a", own, others });
    await expect(resolver.invoke("itx.loop")).rejects.toThrow(/crossed more than 16 contexts/);
  },
);
```

**Keep:** the listing guard at itx-expression-rewriting.ts:905-906 (`there === ownPath`) stays. The depth-bounded listing still needs it.

**Semantic delta to state in the PR:**

- The row is accepted, and the misconfiguration surfaces at use as the generic hop-limit refusal, which does not name the row.
- Only context roots (for example `append`) still answer at that context, so removing the row still works.
- Deliveries through it fail and retry, as the A↔B loop already does.

### Skeptic's verdict

The central claim holds, and I checked it by running the code. `refuseSelfLoopRow` (itx-expression-rewriting.ts:776-794) justifies itself with "a loop no depth budget can see — every hop is a fresh resolve". That stopped being true when #3425 (8c568dbf2, 2026-09-29) made `#route` call `crossingOneMore` on every `cd` it follows (line 1180). The refusal itself is older than the move to apps/os (#2879).

**Probe.** I ran the real `ItxExpressionResolver` from wt-main through tsx, with the `oneContextReach` fake:

- At /a, `itx ⇒ itx.cd('.')` and `itx ⇒ itx.builtins.cd('/a')` both throw "crossed more than 16 contexts", with 0 snapshot reads because the table is live.
- From /b, `itx.go ⇒ itx.cd('/a').foo`, with /a holding an absolute self-link, is refused after 16 snapshot reads. In production those reads are cached (`ruleSnapshots`).
- `itx.append(...)` at the self-linked context still answers, so the owner can remove the row.

**The append check only catches one spelling.** It never covered the general case, and the append boundary accepts both of these today:

- a self-loop through a second row: `itx ⇒ itx.p` plus `itx.p ⇒ itx.builtins.cd('/a')`;
- a non-bare self-cd: `itx.x ⇒ itx.cd('/a').x`.

The hop count refuses both. So this is two loop guards, one of them a partial special case, and they collapse to one.

**(a) What changes:**

1. The row is accepted instead of refused, whoever appends it: `provide`, `itx.append`, a sibling's `cd(path).append`, a `schedule-set` batch (today refused when scheduled), a pager attach, or app-config's root publication events.
2. At that context, every name no context-root row claims fails at use with the generic hop-limit message. That includes `kv` at a child, not only custom names. Only context roots such as `append` still answer.
3. Subscriptions and fetch routes through it fail per delivery and are retried. This is the same as the A↔B loop, which is already admitted.
4. The error no longer names the offending row.
5. A relative bare `cd('.')` means the caller's origin to a located caller, so a foreign caller is bounced back to its own table. The accepted non-bare `itx.x ⇒ itx.cd('.')` rows already behave this way, and it gives no new authority, since `cd` goes anywhere in the project.

No platform flow writes a self-link: collection.ts:163 skips the link when `creator === path`.

**(b) It is simpler.** One loop concept goes, along with its stale rationale. The candidate also missed the biggest win: `ownPath` is `normalizeControlEvent`'s only use of its second parameter. Its only other use is passing it to itself at line 782. Dropping the check makes the append-boundary normalizer a pure function of the event, and about 55 call sites stop passing `"/"` or the DO path.

**(c) Guarantees.** No real guarantee is lost: "a routing loop never runs forever" is kept by the hop count. What goes is an early diagnostic for a hand-written, trusted-client misconfiguration.

**The candidate's spec is wrong in three places:**

1. It misses the e2e row apps/os/e2e/rewrite-rules.e2e.test.ts:268-278 and the header clause at line 17. That row asserts `provide('itx', "itx.cd('/x')")` is rejected with /own context/, so it would go red.
2. Its `test.for` sketch fails `tsc`, because the rows infer a union for `others`. It needs a type parameter.
3. Its LOC figure is off; the measured numbers are in `locMeasured`.

**Verified.** I applied the amended change to a `git archive` copy of main, ran oxfmt, and ran both tsc configs: clean. The five affected unit files pass with a minimal vitest config: 630 tests, including the new self-link row.

**Payoff is modest:** about 25 production lines and one threaded parameter at the append boundary.
