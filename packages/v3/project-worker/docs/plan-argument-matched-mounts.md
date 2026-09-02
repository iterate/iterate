# Plan: argument-matched mounts (`itx.ai.run('some-model')` as a capability path)

Jonas: "I would expect to be able to match `itx.ai.run("some-model")` specifically … I just want to
know if we can do it with less than 80 lines." Answer up front: **yes — ~20 net source lines, ~35
touched, five files**, with ONE rule ("the mount's literal args must equal the call's leading args"),
no matcher kinds, no wildcard. Details and the honest gross list below. (`ai` is not a built-in root
— built-ins.ts:198-293 — so the example is an ordinary userspace mount; under a built-in root no mount
is ever consulted, pinned or not: capability-table.ts:130-136.)

## 1. Today

- **Grammar.** `parse` already reads `itx.ai.run('some-model')` as `["itx","ai",["run","some-model"]]`
  (expression.ts:35-71). Only `parseCapabilityPath` refuses it — "dotted names only", every step must
  be a string (expression.ts:90-97); `CapabilityPath = string[]` (expression.ts:17).
- **`match(path, call)`** (dispatch.ts:40-52): segment by segment; the FINAL segment may claim a call
  step of the same name, its args become `argsAtMount` — the args are never compared. Pinned:
  dispatch.test.ts:47-53 ("call consume is FINAL-segment only").
- **`route`** (capability-table.ts:79-97): longest `path.length`, ties → newest `providedAtOffset`.
  **`resolve`** (capability-table.ts:155-170, commit 3c8c0b61c): a mount is a REWRITE RULE — the
  matched prefix is replaced by the target, `argsAtMount` folds into the target's final property step
  (`itx.grok ⇒ itx.openai.chat`, called `itx.grok({…})` ⇒ `itx.openai.chat({…})`) and the rewritten
  call resolves again.
- **Mount row** `{ path: string[], target: Expression, providedAtOffset }` (core-processor.ts:53-60),
  reduced from `capability-provided { path: string, target: string }` via `parseCapabilityPath`
  (core-processor.ts:188-195). The door canonicalizes as `parseCapabilityPath(path).join(".")`
  (capability-table.ts:53); `canonicalCapabilityPath` is the same join (expression.ts:101-103).
- **Provide idempotency** (DO:509-521): `#newestMountAt(pathString)` filters `m.path.join(".") ===
pathString` (DO:545-549) and compares `print(target)` strings. **Revoke-by-path** (DO:530-542) uses
  the same `#newestMountAt`. **rpc-stub key**: `IterateContext.provide(path, liveValue)` parks under
  `canonicalCapabilityPath(path)` and mounts `itx.rpcStubs.get('<key>')` (iterate-context.ts:172-194);
  `rpcStubAttach` asserts the key IS canonical (DO:649-658). One pin says the door refuses a call step:
  capability-table.test.ts:133-140.

## 2. Options

Common to A–C — the spelling is the string half of the codec, nothing new to learn:

```ts
itx.provide("itx.ai.run('some-model')", "itx.load(src).getEntrypoint().run"); // expression target
itx.provide("itx.ai.run('some-model')", (model, inputs) => …);              // live value
```

**What the target receives (A–C): the pinned args are a GUARD, not a consumption.** `argsAtMount`
stays "the call's args at the mount", so the rewrite forwards `('some-model', inputs)` exactly as
today; the entrypoint's `run(model, inputs)` is a drop-in for the plain mount's. Consuming (stripping
the pinned prefix) would add a slicing rule to `resolve` and make a target's signature depend on how
it was mounted — ruled out. `resolve` changes by zero lines under forward.

**Ranking (A–C):** specificity = `path.length + pinnedArgCount`, then recency — the existing "longest
wins even over a newer shorter one" rule (capability-table.test.ts:158) extended by one term. A
pinned mount and a plain mount of the same names are the ONLY new tie shape (a longer plain path
`itx.ai.run.x` and `itx.ai.run('m')` can never both match one call — the call's third step is a
string or a call, not both), and the pinned one wins.

### A — exact structural equality on the final call step's args

Rule: `jsonEqual(pinnedArgs, callArgs)` (`lib/patch.ts:22` already exports THE deep-equal) — arity
and values. Answers the literal example only when the call is literally `itx.ai.run('some-model')`
with nothing else; a real `ai.run(model, inputs)` never matches, so every mount would have to spell
the inputs too. Same line count as B, strictly less useful. **Dominated by B.**

### B — prefix: the mount's literals equal the call's LEADING args; extra call args pass through

Rule: `pinned.every((a, j) => jsonEqual(a, callArgs[j]))`. `itx.ai.run('some-model')` matches
`itx.ai.run('some-model', { prompt })` and forwards both args; `itx.ai.run('other', …)` falls through to
the plain `itx.ai.run` mount (or default-deny). `itx.ai.run('m', { stream: true })` as a path pins two
and outranks `itx.ai.run('m')` for calls carrying both. This is "match the first argument", which is
what "match `ai.run("some-model")` specifically" means in practice. **RECOMMENDED — the code:**

```ts
// expression.ts — the type and the parser (+5 net)
export type CapabilityPath = Expression; // dotted names, optionally ONE final call step pinning leading args
export function parseCapabilityPath(source: string): CapabilityPath {
  const expr = parse(source);
  const last = expr.at(-1);
  if (!expr.slice(0, -1).every((step) => typeof step === "string"))
    throw new Error(`a capability path may only END in a call — ${JSON.stringify(source)}`);
  if (Array.isArray(last) && last.length === 1)
    throw new Error(`${JSON.stringify(source)} pins no args — spell it without "()"`);
  return expr;
}
export function canonicalCapabilityPath(source: string): string {
  return print(parseCapabilityPath(source)); // was .join(".") — identical output for dotted names
}

// dispatch.ts — match (+3 net, +1 import)
export function match(path: CapabilityPath, call: Expression): Match | null {
  let argsAtMount: unknown[] | undefined;
  for (let i = 0; i < path.length; i++) {
    const p = path[i];
    const c = call[i];
    if (c === undefined) return null; // path longer than the call
    const name = typeof p === "string" ? p : p[0];
    const pinned = typeof p === "string" ? [] : p.slice(1);
    if (typeof c === "string") {
      if (c !== name || pinned.length) return null; // a pinned step needs a call to compare against
    } else if (c[0] !== name || i !== path.length - 1)
      return null; // call consume: final only
    else if (!pinned.every((a, j) => jsonEqual(a, c[j + 1])))
      return null; // pinned ≠ leading args
    else argsAtMount = c.slice(1);
  }
  return { argsAtMount, stepsAfterMount: call.slice(path.length) };
}

// capability-table.ts — route's ranking term (+5)
/** How much of a call a mount claims: its segments plus the args its final call step pins. */
const specificity = (m: Mount): number => {
  const last = m.path.at(-1);
  return m.path.length + (Array.isArray(last) ? last.length - 1 : 0);
};
// …then the three `mount.path.length` comparisons in route() read `specificity(mount)`.
```

| File                                   | Change                                                                                                                           | Net lines |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | --------: |
| `context/expression.ts`                | `CapabilityPath = Expression`; `parseCapabilityPath` final-only + no-bare-`()`; `canonicalCapabilityPath` = `print(...)`         |        +5 |
| `context/dispatch.ts`                  | `match` compares pinned leading args; import `jsonEqual`; docstring                                                              |        +6 |
| `context/capability-table.ts`          | `specificity` helper, three comparisons in `route`; door `.join(".")` → `print(...)`; header comment                             |        +7 |
| `stream/core-processor.ts`             | `path: z.array(z.string())` → `z.custom<Expression>(() => true)` (as `target` already is); one sentence in the event description |        +1 |
| `iterate-context-durable-object.ts`    | `#newestMountAt`: `m.path.join(".")` → `print(m.path)` (`print` already imported)                                                |         0 |
| `iterate-context.ts`, relay, directory | nothing — they already go through `canonicalCapabilityPath`                                                                      |         0 |
| `e2e/support/client.ts:133-135`        | `rpcStubMountPaths` joins with dots → `print(m.path)` (test support)                                                             |         0 |
| **Total**                              | **~+19 net, ~35 touched; ranking +5, canonicalization 3 one-word swaps**                                                         |   **~19** |

### C — a wildcard / placeholder (`itx.ai.run(_)`, `itx.ai.run('*')`)

Under B a wildcard only buys "pin a LATER arg without the earlier one" (`run(_, { stream: true })`) or
"match only when called with ≥1 arg" — no consumer for either. `_` is not JSON5 (a grammar
extension), `'*'` collides with the legitimate literal `"*"`, and either is the first of the "different
kinds of matchers" Jonas fears. **Not worth having; refuse by omission** (nothing to write — the
parser already rejects `_`). If it is ever needed, D covers it.

### D — don't do it in the path: a plain mount whose target switches

`itx.ai.run ⇒ itx.load(src).getEntrypoint().run`, and the worker does `model === 'some-model' ? … :
fallback(model, inputs)`. **Zero kernel lines, available today.** Costs: one loaded-worker hop per call,
the routing is invisible in the table (a snapshot says `itx.ai.run ⇒ X`, not which models), and — the
real one — the FALLBACK must be re-spelled under another name: the switching worker cannot call
`itx.ai.run(...)` for the models it does not own (that is its own mount → depth-32), and the shadow
stack has no `super`. Under B the fallback is free: the plain `itx.ai.run` mount stays beneath and
catches the rest.

### Mid-path call steps (`itx.ai('gpt').run`) — ruled OUT

A different beast. The rewrite replaces the matched PREFIX wholesale, so a mid-path pinned call step
would be CONSUMED (`itx.ai('gpt').run ⇒ itx.x` turns `itx.ai('gpt').run(p)` into `itx.x(p)`), while a
final pinned step is FORWARDED — two behaviours for one syntax. The grammar keeps "a call step in a
path is FINAL only" (the same rule `match` already enforces for the call, dispatch.ts:47); lifting it
later is deleting one `if` plus deciding the consume question.

## 3. What gets gross

- **rpc-stub registry key.** `itx.provide("itx.ai.run('some-model')", fn)` parks under the key
  `itx.ai.run('some-model')`; the mount's target prints as
  `itx.rpcStubs.get("itx.ai.run('some-model')")` (JSON5 flips to double quotes to embed the
  single-quoted key). It round-trips (`matchingParen` skips both quote styles, expression.ts:26-27;
  JSON5 escapes a literal holding both) but the log line is a string inside a string inside a string,
  and `itx.rpcStubs.list()` returns keys with parens and quotes.
- **`revoke("itx.ai.run('some-model')")`** works unchanged (canonical path). `revoke("itx.ai.run")`
  does NOT pop it — a different exact path — so the table holds two independent shadow stacks for
  `itx.ai.run` and `itx.ai.run('some-model')`. Correct, but a user must revoke each.
- **Idempotency + `#newestMountAt`** compare canonical STRINGS. JSON5 preserves object key order, so a
  pinned `{a:1,b:2}` and `{b:2,a:1}` are two rows to the door and one match to `route` (`jsonEqual`
  is order-insensitive): a duplicate that always ties → newest wins, a harmless shadow. NOT new —
  target args are already compared as printed strings (DO:514) with the same property. Pin scalars.
- **Shadow stack with mixed args/no-args:** an OLDER pinned mount beats a NEWER plain one (specificity
  before recency — the rule capability-table.test.ts:158 already pins for length). Surprising only if
  one expects flat newest-wins.
- **Printing/canonicalization:** the log shows what `print` renders, not what was typed — single
  quotes (double if the literal contains `'`), `1.0`→`1`, `0x10`→`16`, `1e21`→`1e+21`,
  `undefined`→`null`, insertion key order. Identical to targets today (the two round-trip pins at
  capability-table.test.ts:358-382 cover the same edges). `jsonEqual` uses `Object.is`, so a pinned
  `NaN` matches `NaN` and `-0` does not match `0` — curiosities, not hazards.
- **Snapshot consumers** that assumed `path: string[]` must print — one in e2e support
  (`rpcStubMountPaths`, client.ts:133-135); nothing in `src/`.
- **The fetch plan's D3** is the same question ("which calls are SENT to this target, decided before
  it is called") but its matcher runs over a `Request`, which is `extraArgs`, never expression data
  (capability-table.ts:116-117) — a pinned literal can never see a host or a method. The two matchers
  do not unify; B neither helps nor hurts D3. The hazard is the reverse: once args live in paths,
  someone proposes `itx.fetch({ host: '*.stripe.com' })` — that is option C; refuse it.

## 4. Recommendation

**Do B, guard-only, final-step-only, no wildcard.** It answers the example (`itx.ai.run('some-model',
inputs)` routes to the pinned mount, every other model to the plain one) for **~19 net source lines,
~35 touched, five files — under 80 with the ranking term (+5) and the canonicalization (three
`.join(".")` → `print(...)` swaps, 0 net) included**, because the grammar already parses the spelling,
the rewrite already forwards `argsAtMount`, `jsonEqual` already exists, and `print` of a dotted path
IS today's join. The one new concept is a single sentence: "a path may end in a call whose literals
must equal the call's leading args; a pinned arg counts as a segment for ranking."

Pins to add:

- `capability-table.test.ts` — flip :133-140 ("dotted names only") to: final call step accepted,
  mid-path call refused, bare `()` refused. `route`: an older pinned mount beats a newer plain one;
  a non-matching first arg falls through to the plain mount; extra call args pass through; two
  pinned args outrank one. Resolve: a live provide under a pinned path (target prints the quoted
  key, `list()` shows it, `revoke` by the pinned path restores the plain mount).
- `dispatch.test.ts` — two rows in the `match` table (pinned hit with a trailing arg; pinned miss) and
  one reject ("pinned step against a property step").
- One e2e through the real DO, `capability-table-argument-pinned-mounts.e2e.test.ts` (~25 lines,
  `freshCtx`/`session` from support): provide `itx.ai.run ⇒ stub A`, then `itx.ai.run('some-model') ⇒
stub B`, call both models, `revoke("itx.ai.run('some-model')")`, assert A serves both and
  `rpcStubMountPaths` shrinks by the printed key.

If Jonas wants ZERO kernel lines, D is available today at the price of a hop and a re-spelled fallback.
