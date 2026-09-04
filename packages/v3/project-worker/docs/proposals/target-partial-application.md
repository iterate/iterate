> SUPERSEDED 2026-09-04, same day: Jonas chose the `@` topic token over `?`/`...` — "the caller's input", spliced as an argument, the one argument when nested, `...@` merging an object's fields — shipped as rule 7 in commit 8dbae1329. This file is the research that preceded that call and is kept as history; its verdict no longer applies.

DRAFT, research interrupted.

# Target-side partial application — a hole in a rewrite rule's target

> **RESEARCH, written 2026-09-04** against `src/context/expression.ts`,
> `src/context/itx-expression-rewriting.ts` and its table test as they stand today (rule 4 folds the
> caller's unpinned args into the target's final step when that step is a NAME, else makes an
> ANONYMOUS call on the target's result). Nothing here is implemented. The argument and the verdict
> are complete; the items below were not verified before the session was stopped.

**Still unverified**

1. **`env.AI.run`'s exact arity.** The Workers AI bindings page shows `env.AI.run('@cf/…',
   { prompt })` and describes `stream` as an option *inside* that second argument. A third
   positional `options` argument (gateway config, extra headers) is taken from the task framing, not
   from a page I read. Example (1) depends only on "model first, caller's args after", which holds
   either way — but confirm before writing the rule.
2. **GraphQL variables.** `spec.graphql.org` and `graphql.org/learn/queries` both returned 403; that
   one-line prior-art claim is from memory, not a source I read. Jinja and Kotlin's `it` were
   dropped rather than asserted unread.
3. **Why partial application actually stalled.** Inferred from issue #13 plus "last presented
   2021-10" in `stage-1-proposals.md`. No TC39 plenary notes were read directly, so there may be a
   substantive objection after 2021 that this document does not know about.
4. **Pipeline operator status "as of 2026"** rests on the proposals repo still listing it at Stage 2
   and no 2025–26 plenary note being read. The bikeshed table was read through a summarizing fetch,
   not verbatim — treat individual pro/con wordings as paraphrase.
5. **The LOC table is an estimate, not a prototype.** Nothing was built, no test was run. The
   riskiest number is the ~55-line pre-tokenizer; a spike over `matchingParen`'s quote-skipping loop
   would settle it in an hour.
6. **The table test moved under me.** Another agent edited
   `src/context/itx-expression-rewriting.test.ts` mid-session, so the proposed rows are written
   against the row *shape*, not against pinned line numbers.

## Verdict — ADAPT, and the token is `?`

Steal the **vocabulary** of [tc39/proposal-partial-application][pa] (`?0`/`?1` ordinal holes, `...`
rest) and nothing else. Do **not** steal its `~()` call marker: that marker exists because in JS a
partial application is an expression that must not be mistaken for a call, and in itx a rewrite
rule's target is *already* a template that is never itself evaluated — there is nothing to
disambiguate it from, so the marker is dead weight. Do **not** steal a topic token (`%`, `#`, `@`,
`^^`) from [the pipeline operator][pipe]: a topic names **one** piped value, itx substitutes **N**
caller arguments, so a topic token is strictly less expressive and imports a concept ("the pipe")
this language does not have. The `@` the owner half-remembers is on the pipeline proposal's
*disqualified* list anyway. Add one thing neither proposal has — `...?n` inside an object literal,
a **field merge**, because AI-gateway shape (2) needs to merge into `query`, not fill a slot. The
decisive fact for the codec: **`?`, `?0` and `...` are not valid JSON5 in any position**, so adding
them to the argument grammar cannot change the meaning of any rule that parses today — it is a pure
extension of currently-erroring input. And it is not gratuitous: `...` in a target's final argument
list is *precisely the disambiguator* rule 4 lacks between "append the caller's args to this call"
(`itx.ai.run('@cf/…', ...)`) and "call the result" (`itx.rpcStubs.get('cam')` → `(…)`), which today
is decided by a fixed heuristic and cannot be overridden. **Ship `...` first (~60 lines); ship
`?n` + `...?n` as a second increment (~180 lines total).**

## What the proposals actually say

| Proposal | Token(s) | Stage / status | Read |
| --- | --- | --- | --- |
| [Partial application][pa] — Ron Buckton | `f~(?, x)`; `?` sequential hole, `?0`/`?1` ordinal, `...` rest | **Stage 1**, last presented to plenary **2021-10** ([stage-1-proposals.md][s1]) | 2026-09-04 |
| [Pipeline operator][pipe] — Choi, DiGioia, Buckton, Atkins | `x \|> f(%)`; topic token currently `%` | **Stage 2** since **2021-08-31**; README: the token "will _almost certainly not be the final choice_" | 2026-09-04 |
| [Hack topic token bikeshed][bike] | `#` `##` `^^` `<^` `%%` `@@` `#_` live; `%` `^` `*` `~` `?` `@` `::` `$` `_` rejected | wiki, no decision | 2026-09-04 |
| [Call-this][bind] — J. S. Choi | `receiver~>fn(a)` | Stage 1, last presented **2022-03** (bikeshedding) | 2026-09-04 |
| [Function.pipe/flow][fpf] — J. S. Choi | none | **Withdrawn** — rejected for Stage 1, July 2022 plenary | 2026-09-04 |

Facts worth carrying:

- Partial application's semantics are about **evaluation**: "Given `f~(?, x)`, the non-placeholder
  argument `x` is evaluated immediately and fixed"; "Given `o.f~(?)`, the `this` receiver … is fixed
  as `o`". itx has neither problem — a target's literals are JSON already evaluated, and
  `dispatch.ts` carries the receiver through `walkSteps` regardless.
- The `~()` marker was added after **Waldemar Horwat, Sept 2017** ([issue #13][pa13]): bare
  `foo(x++, y(g,h), "hello", ...)` forces you to scan the whole argument list to learn it is not a
  call, and bare `f(?)` cannot express a **zero-argument** partial application. Neither objection
  transfers: a target is only ever a template, and the zero-arg case is what a hole-free target
  already means today.
- Token rejections in [the bikeshed][bike] are all JS-grammar collisions: `?` "conflicts with the
  conditional operator, `??`, `?.`"; `@` "complex interactions with decorator syntax"; `$`/`_`/`it`
  "risk of shadowing common outer variables". **None of these apply to a JSON5 argument list**,
  which has no ternary, no decorators and no identifier values. The token JS cannot have is the one
  itx can.
- Prior art for a hole in a literal tree, one line each: **jq** — "`.` … takes its input and
  produces the same value", one implicit topic, no positional holes (read 2026-09-04).
  **Clojure** — `#(…)` with "`%`, `%n` or `%&`; `%` is a synonym for `%1`", the closest match to
  `?`/`?n`/`...` and evidence the three-part vocabulary is the right one ([reader][clj]).
  **Scala** — `_ * 2` expands positionally by occurrence order, i.e. sequential like bare `?`
  ([spec §6][scala]). **JSONata** — `$` is "the context value", one topic ([docs][jsonata]).
  **Helm/Go templates** — `.` is the current scope, `$` the root: two topics, no holes.
  **GraphQL** — `$var` substitutes anywhere inside a literal input object, the nearest thing to
  `...?n`, but *named* rather than positional. Nothing here offers an object-field merge.

## Mapping onto the itx target grammar

| Need | Spelling in a target | Array half | Rule-4 effect |
| --- | --- | --- | --- |
| one caller argument | `?0`, `?1`, … | `{"?": 0}` | substitute `unpinnedArgs[n]` |
| the remainder | `...` (argument list only) | `{"?": "..."}` | splice all `unpinnedArgs` at that position |
| fields of one argument | `...?0` (object entry only) | entry `"...": 0` | merge `unpinnedArgs[n]`'s own keys, template keys win |
| sequential hole (`?` bare) | **not adopted** | — | Buckton's `?` fills left-to-right; a second meaning for a `?`-shaped token in a config file humans diff is a trap. Require the ordinal. |
| a topic (`%`, `@`) | **not adopted** | — | one topic cannot address N arguments |
| the `~()` marker | **not adopted** | — | nothing to disambiguate |

## Codec cost

**String half (`parse`).** Arguments today are one `JSON5.parse("[" + inner + "]")`, deliberately —
the file's docstring says "no hand-rolled number/object parser". Holes cannot be JSON5, so the raw
argument source must be **pre-tokenized** before that call: a scanner over `inner` that maintains a
bracket stack and skips quoted strings *and JSON5 comments* (JSON5 allows `//` and `/* */`, and a
comment can contain `...`), rewriting `?n` → `{"?":n}`, a value-position `...` → `{"?":"..."}`, and
an object-entry `...?n` → `"...":n`. The quote-skipping loop already exists in `matchingParen` and
can be lifted. **The `...`-only increment needs no scanner at all**: a bare `...` is legal only as
the last element of an argument list, and the only way trimmed `inner` can end in `...` outside a
string is the real thing — a six-line suffix check.

**Array half + print.** `print` today is one `JSON5.stringify(step.slice(1), keySortedForPrint)`. A
replacer returns values, not raw text, so it cannot emit a bare `?0`; `print` needs a small
recursive argument emitter that renders holes itself and delegates every hole-free subtree back to
`JSON5.stringify`. Round-tripping is mandatory, not optional: the door canonicalizes with
`parse(print(toItxExpression(target)))` and the event stores the string half.

**Sentinel collision — real, and must be declared.** An object whose only key is `"?"`, and the
object key `"..."`, become **unspellable as literals inside a target**. A user who genuinely wants
`{"?": 0}` as a target argument cannot have it. This is a documented reservation, not a check that
can catch it, because the pre-tokenizer leaves a *quoted* `"?"` key alone and the hole detector
cannot tell the two apart afterwards. Paranoid alternative: key the sentinel `"itx:?"` /
`"itx:..."`, uglier in the array half, collision-free in practice. Matches and calls are unaffected:
holes are refused there, so caller data never means a hole.

**Canonical spelling and the table key.** The rule table is keyed by **canonical match**, and a
match may never contain a hole — **the key is untouched**. Only a target's printed form changes,
and only when a hole is present. One new canonicalization rule: a spread entry prints **first**, in
ordinal order, ahead of the sorted literal keys — which is both canonical and truthful, because a
spread is applied first and the template's literals win (see below).

## The proposed grammar

1. `?n` (`n` = 0–9) denotes **caller argument `n`**, in any value position inside a target's call
   arguments, at any nesting depth, in any step (not only the final one — fewer distinctions).
2. `...` denotes **every caller argument, spliced**, and is legal only as a top-level element of a
   target's argument list.
3. `...?n` denotes **the own enumerable fields of caller argument `n`**, and is legal only as an
   object-literal entry, at most one per object. **The object's own literal keys are applied after
   the merge and win** — a rule that pins `model: 'claude-x'` cannot be talked out of it by the
   caller. This is the safe default and it is why the spread prints first.
4. A target uses ordinals **or** a rest, never both — the interaction is refused, not defined.
5. Holes are legal **only in a rewrite rule's target**: never in a `match` (a match pins literals),
   never in a call handed to `invoke` (a caller's expression is data, not a template).
6. Arity: an ordinal naming an argument the caller did not pass is a refusal at rewrite time. A
   `...` with nothing to splice is **empty, not an error** — it drops.

## Five worked examples

```
(1) POSITIONAL — env.AI.run(model, inputs, options?)
    rule  itx.fable ⇒ itx.ai.run('@cf/meta/llama-3.1-8b-instruct', ...)
    call  itx.fable({prompt:'hi'}, {stream:true})
    runs  itx.builtins.ai.run('@cf/meta/llama-3.1-8b-instruct',{prompt:'hi'},{stream:true})
    (today, with no marker, this target ends in a CALL step, so rule 4 makes an anonymous call:
     itx.builtins.ai.run('@cf/…')({prompt:'hi'},{stream:true}) — wrong. `...` is the fix.)

(2) ONE OBJECT ARGUMENT — env.AI.gateway(id).run({provider, endpoint, headers, query})
    rule  itx.fable ⇒ itx.ai.gateway('g').run({provider:'anthropic',endpoint:'v1/messages',
                        query:{...?0,model:'claude-x'}})
    call  itx.fable({messages:[{role:'user',content:'hi'}]})
    runs  itx.builtins.ai.gateway('g').run({endpoint:'v1/messages',provider:'anthropic',
            query:{...?0,model:'claude-x'} → {messages:[…],model:'claude-x'}})
    (the caller cannot override the pinned model: template keys are applied last.)

(3) A LENT STUB CALLED WITH ARGS — no marker, behaviour unchanged
    rule  itx.cam ⇒ itx.builtins.rpcStubs.get('itx.cam')
    call  itx.cam(1,2)
    runs  itx.builtins.rpcStubs.get('itx.cam')(1,2)
    (a hole-free target takes today's rule-4 path byte for byte; this is the compatibility anchor.)

(4) A PROPERTY ACCESS ON THE MATCH — the marker DROPS
    rule  itx.fable ⇒ itx.ai.run('@cf/meta/llama-3.1-8b-instruct', ...)
    call  itx.fable.describe()
    runs  itx.builtins.ai.run('@cf/meta/llama-3.1-8b-instruct').describe()
    (the match's final NAME step matched a NAME step, so there are no unpinned args; `...` splices
     nothing and the steps after the match follow, exactly as today.)

(5) A REFUSAL — an ordinal with nothing to fill it
    rule  itx.fable ⇒ itx.ai.gateway('g').run({query:{...?0}})
    call  itx.fable()
    throws  NO_ITX_EXPRESSION_MATCH: "itx.fable()" — the target names caller argument 0 and the
            call passed none
```

## The exact change to rule 4 and the door

`applyItxExpressionRewriteRule` gains **one branch, taken only when the target contains a hole**
(computed once at reduce, stored on the rule):

```
no hole            → today's code, unchanged (append to the final NAME step, else anonymous call)
hole, args present → deep-substitute holes through every step's argument tree; append NOTHING;
                     then stepsAfterMatch as always
hole, no args      → the same substitution with unpinnedArgs = [] (rest → empty, ordinal → refuse)
```

`rewriteRuleConfiguredEvent` gains the door checks, all in the target: holes appear only inside call
arguments; `...` only at the top level of an argument list; `...?n` only as an object entry, at most
one per object; ordinals and a rest never mixed; ordinal ≤ 9. `parseItxExpressionPrefix` gains one
refusal — a hole in a prefix — which covers both the `match` and every `provide(match, …)` sugar
call. `resolveItxExpression` needs no change beyond the arity refusal raised from rule 4, which
reuses `NO_ITX_EXPRESSION_MATCH`.

## Test rows for `itx-expression-rewriting.test.ts`

| rules | call | becomes |
| --- | --- | --- |
| `itx.f ⇒ itx.kv.get('p', ...)` | `itx.f('k')` | `itx.builtins.kv.get('p','k')` |
| `itx.f ⇒ itx.kv.get('p', ...)` | `itx.f('k','v')` | `itx.builtins.kv.get('p','k','v')` |
| `itx.f ⇒ itx.kv.get('p', ...)` | `itx.f()` | `itx.builtins.kv.get('p')` |
| `itx.f ⇒ itx.kv.get('p', ...)` | `itx.f.deep()` | `itx.builtins.kv.get('p').deep()` |
| `itx.f ⇒ itx.kv.get(?0)` | `itx.f('k','ignored')` | `itx.builtins.kv.get('k')` |
| `itx.f ⇒ itx.kv.get(?1, ?0)` | `itx.f('a','b')` | `itx.builtins.kv.get('b','a')` |
| `itx.f ⇒ itx.kv.get({q:{...?0,m:'x'}})` | `itx.f({a:1})` | `itx.builtins.kv.get({q:{a:1,m:'x'}})` |
| `itx.f ⇒ itx.kv.get({q:{...?0,m:'x'}})` | `itx.f({m:'y'})` | `itx.builtins.kv.get({q:{m:'x'}})` (template wins) |
| `itx.f ⇒ itx.kv.get({q:{...?0}})` | `itx.f({})` | `itx.builtins.kv.get({q:{}})` |
| `itx.f ⇒ itx.kv.get([?0, 'lit'])` | `itx.f(7)` | `itx.builtins.kv.get([7,'lit'])` (nested in an array) |
| `itx.f ⇒ itx.kv.get(?0).put(?1)` | `itx.f('k','v')` | `itx.builtins.kv.get('k').put('v')` (a hole in a non-final step; nothing is appended) |
| `itx.f('m') ⇒ itx.kv.get('p', ...)` | `itx.f('m','k')` | `itx.builtins.kv.get('p','k')` (pinned arg consumed first) |
| `itx.cam ⇒ itx.builtins.rpcStubs.get('itx.cam')` | `itx.cam(1,2)` | `itx.builtins.rpcStubs.get('itx.cam')(1,2)` (unchanged) |

Refusals: `?0` with no caller args · a hole in a `match` · a hole in a call passed to `invoke` ·
`...` not at the top of an argument list · `...?0` outside an object · two `...?n` in one object ·
ordinals mixed with `...` · `?10`. Codec rows: `parse(print(e))` round-trips each of `?0`, `...`,
`...?0`; `{...?0,b:1,a:2}` and `{a:2,...?0,b:1}` print to the same canonical string; a target
literal `{"?":0}` is refused with the reservation message.

## LOC and risks

| Where | `...` only | full grammar |
| --- | --- | --- |
| `expression.ts` parse | ~8 (suffix check) | ~55 (bracket/quote/comment scanner) |
| `expression.ts` print | ~6 | ~25 (recursive emitter) |
| `itx-expression-rewriting.ts` rule 4 | ~12 | ~40 (deep substitution walk) |
| door + prefix refusals | ~10 | ~30 |
| types + docstrings | ~8 | ~20 |
| **source total** | **~45** | **~170** |
| tests | ~40 | ~120 |

`expression.ts` is 139 lines today; the full grammar grows it by roughly 60%, and that is the honest
answer to "does it make it much more complicated again?" — **`...` alone does not; the full grammar
does, by about half a file.**

Risks, in order of how much they should worry you:

1. **The pre-tokenizer is the only hand-rolled parsing in the codec**, and the file's docstring
   currently boasts there is none. It must skip quoted strings *and* JSON5 comments; a comment
   ending in `...` before the closing paren is a genuine false positive for the cheap suffix check.
   Mitigation: forbid comments in argument source, or ship `...`-only and never write the scanner.
2. **The reserved sentinels are unspellable literals.** Declared, not detectable.
3. **Two ways to say one thing.** `itx.f ⇒ itx.kv.get('p', ...)` and `itx.f ⇒ itx.kv.get('p')` now
   mean different things where before only one parsed — a reader must notice a trailing `...`. This
   is exactly Horwat's 2017 objection, and it is the one that *does* transfer.
4. **Spread precedence is a choice, not a law.** "Template keys win" is safer and is what a pinning
   rule is for, but it reads backwards to a JS eye unless the spread always prints first — hence
   that print rule; do not drop it.
5. **The cheap alternative exists and should be named.** Both AI shapes can be had *today* with zero
   codec change by lending a live stub (`itx.provide('itx.fable', fn)`) that does the partial
   application in JS. It costs a socket, a lifetime and an eviction story for what is pure data, and
   it cannot survive as a config row in the log — which is precisely the doctrine in the rewriting
   header ("the log records the rule, never the socket"). That is the argument *for* holes; it is
   also the reason not to rush past `...`.

[pa]: https://github.com/tc39/proposal-partial-application
[pa13]: https://github.com/tc39/proposal-partial-application/issues/13
[pipe]: https://github.com/tc39/proposal-pipeline-operator
[bike]: https://github.com/tc39/proposal-pipeline-operator/wiki/Bikeshedding-the-Hack-topic-token
[bind]: https://github.com/tc39/proposal-bind-this
[fpf]: https://github.com/js-choi/proposal-function-pipe-flow
[s1]: https://github.com/tc39/proposals/blob/main/stage-1-proposals.md
[clj]: https://clojure.org/reference/reader
[scala]: https://scala-lang.org/files/archive/spec/2.13/06-expressions.html
[jsonata]: https://docs.jsonata.org/programming
