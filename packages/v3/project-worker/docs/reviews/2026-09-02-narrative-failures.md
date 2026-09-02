# Narrative failures — `packages/v3/project-worker`, 2026-09-02

> A read of the STORY this package tells about itself, against the code at `44a286376`. Not a
> correctness review: every finding below is a place where a sentence, a name, a test title or a
> file layout would send a new reader somewhere the code no longer is. Nothing was edited. Each
> finding is `file:line`, the offending text verbatim, what is true now, and the one-line fix.

## Summary

1. **Both "current" maps are wrong on today's headline change.** `LAYERS.md:140` still says
   `disableProcessor` appends the event **and then** calls `itx.facets.delete(name)` — the code
   appends ONE event and the DO does the delete. `docs/itx-surface-as-built.md` contradicts itself
   inside one section on whether a worker source may be a producer expression (§12 "B" says the
   branch is deleted; §12 "F" and §5 say it is back — F is true).
2. **`load` is dead on the surface but alive in six headers**, including the docstring that promises
   "a reader of this file sees the whole surface" (`src/iterate-context.ts:108`), the rules header
   (`itx-expression-rewriting.ts:4`) and the rewrite-rule table test's own fixture. The deleted
   `rewrite` verb survives in `dotted-path-proxy.ts:7`.
3. **The doc a reader is _pointed at_ as "the design record" argues for the API that lost.**
   `itx-surface-as-built.md:7` → `proposals/itx-surface-SYNTHESIS.md`, whose §1 says "the verb is
   `rewrite`" and whose §9 lists `ProvidedRpcStubHandle` as a class — both retracted 250 lines and
   5 lines later respectively, in the same file.
4. **Five docs dated _today_ describe code that does not exist**, three of them under false status
   banners: `plan-argument-matched-mounts.md:3` says "**LANDED 2026-09-02**" and names
   `src/context/routing.ts`, which is deleted; `proposals/guard-audit.md` is a commit plan whose
   nine target symbols have **zero** occurrences in `src/`.
5. **The tutorial's flagship snippet cannot work**, four e2e files are still named for the deleted
   `itx.load` verb, and the gitignored `tutorial-proof/` harness pins `ProvidedRpcStubHandle` and
   `IterateContext["rewrite"]` in TypeScript that has never compiled.

**Findings: 42** — 12 critical, 15 significant, 15 minor.

---

## A. Critical — a reader copies this and it is wrong

### A1. `LAYERS.md:140-141` — `disableProcessor` described as two acts

> `disableProcessor(name)` appends `subscription-configured { name, target: null }` and then
> `itx.facets.delete(name)`.

**True now:** `src/iterate-context.ts:320-322` — `disableProcessor` is ONE append and nothing else.
The facet is deleted DO-side by `#deleteFacetsWhoseHostingSubscriptionWasRemoved`
(`iterate-context-durable-object.ts:215`), which is precisely why the raw event IS the disablement.
`docs/itx-surface-as-built.md:404` ("`disableProcessor` is one event") and the verb's own docstring
both say so — LAYERS is the odd one out, and LAYERS is the file the SUPERSEDED banner on four other
docs sends readers to.

**Fix:** "`disableProcessor(name)` appends `subscription-configured { name, target: null }`; the DO
deletes the facet that row hosted before the append returns."

### A2. `docs/itx-surface-as-built.md:429-434` — §12 "B, done" says sources are inline only

> **B, done:** sources are INLINE ONLY — `WorkerSource = Record<string, string>` … The
> producer-expression branch (`"itx.kv.get('src/x.js')"`), the old inline wrapper object, the
> loader's `invoke` and `resolved` options and the DO's resolved-source cache are deleted

**True now:** `src/context/worker-loader.ts:52` — `export type WorkerSource = WorkerModules |
ItxExpressionInput`. Commit `690d7770c` deleted the producer branch; `038f127a9` put it back behind
a required `cacheKey`. The loader still takes `invoke` (`worker-loader.ts:76`), and
`worker-loader.test.ts:73` pins the "needs a cacheKey" refusal. §12's own "F, done" (line 421) and
§5 (line 292) both say so — but B is listed LAST, so a reader skimming §12 top-to-bottom lands on
the false claim.

**Fix:** rewrite B to "sources are the modules literally, OR a producer expression under a required
`cacheKey` (see F); the inline wrapper object, the loader's `resolved` option and the DO's
resolved-source cache are deleted."

### A3. `src/iterate-context.ts:107-108` — the "whole surface" docstring lists a deleted root

> WHAT RIDES THE HOP, TYPED: every built-in root (`append`, `read`, `waitForEvent`, `kv`,
> `rpcStubs`, `facets`, `load`, …) … So a reader of this file sees the whole surface

**True now:** there is no `load` root. `BuiltInScope` (`src/context/built-ins.ts:61`) is
`whoami · kv · append · read · waitForEvent · cd · fetch · rpcStubs · rewriteRules · facets ·
subscriptions · workers · runScript`. The docstring's entire promise is that this list is the
surface, so a dead name here is maximally misleading.

**Fix:** `` `facets`, `workers`, … ``

### A4. `src/context/itx-expression-rewriting.ts:4` — `load` as a built-in in the rules header

> Rewriting repeats until the call's root is a BUILT-IN (the physical scope: kv, whoami, rpcStubs,
> load, …)

**True now:** as A3. This is the header of the ONE file that owns the matching rules — the first
thing anyone reading dispatch opens.

**Fix:** `(the physical scope: kv, whoami, rpcStubs, workers, facets, …)`

### A5. `src/context/itx-expression-rewriting.test.ts:4, 20` — the rule table's own fixture invents a root

> `:4` Built-in roots for the table: kv, whoami, rpcStubs, load.
> `:20` `const BUILT_IN_ROOTS = new Set(["kv", "whoami", "rpcStubs", "load"]);`

**True now:** `load` is not a built-in root and no row in the table uses it (rows use `kv`,
`whoami`, `rpcStubs`, `facets`). This file is the doc-of-record for the five matching rules, so it
teaches a root that does not exist.

**Fix:** swap `load` for `workers` in both places.

### A6. `src/context/dotted-path-proxy.ts:7` — the deleted `rewrite` verb in the module header

> even though `IterateContext` declares only fixed methods (invoke / provide / rewrite / …)

**True now:** the class declares `cd · invoke · provide · subscribe · enableProcessor ·
disableProcessor`. `rewrite` was deleted in `b0e6c4a32` and absorbed into `provide`.

**Fix:** `(cd / invoke / provide / subscribe / …)`

### A7. `docs/tutorial-build-the-iterate-context.md:701-707` — the flagship Chapter 1 snippet cannot work

> ```ts
> using laptop = await itx.provide("laptop", {
>   stub: async (cmd, args) => {…},
>   rewrite: "itx.runOnMyComputer",
> });
> ```

**True now:** `provide(match, target)` takes exactly two arguments (`src/iterate-context.ts:194`);
there is no options bag, no `stub` key, no `rewrite` key, and the rpc-stub key IS the canonical
match. Copying this lends **the object literal itself** as the stub under the key `"laptop"` —
silently wrong, no error. Same defect at `:983` (`itx.provide("tunnel", new Tunnel(), { rewrite:
"itx.bla" })`), `:610`, `:27`, `:838`.

**Fix:** `using laptop = await itx.provide("itx.runOnMyComputer", async (cmd, args) => {…});`

### A8. `docs/tutorial-build-the-iterate-context.md:26-37` — the ORDER NOTE names three deleted APIs and warns about the wrong thing

> **ORDER NOTE (2026-09-02).** The code's layer order is: **(1) rpc stubs** —
> `provide(rpcStubKey, stub)` + `invoke` … **(3) rewrite rules** — `rewrite(match, target | null)`
> and `provide`'s `rewrite` option … The names below already follow the code

**True now:** `provide(rpcStubKey, stub)`, `rewrite(match, target|null)` and "`provide`'s `rewrite`
option" are all deleted, and "the names below already follow the code" is false. Worse, the note is
scoped entirely to **Part 0's brick ordering** — it says nothing about Chapters 1-3, which is where
every stale API actually lives. A reader takes it as "the toy is out of order but correct", then
copies `itx.rewrite` and `itx.load` from Chapter 1 believing them current.

**Fix:** retitle to `STALE-API NOTE`, list the deleted verbs, and state that Chapters 1-3 predate
the `provide`-unification.

### A9. `docs/tutorial-build-the-iterate-context.md:824, 430, 435, 590, 724, 1176, 1197` — `itx.rewrite(...)`

> `:824` `using todos = await itx.rewrite("itx.todos", [ … ]);`
> `:724` `itx.rewrite("itx.shell", "itx.rpcStubs.get('laptop')")` points another name at an
> already-lent stub

**True now:** `provide(match, target | null)` is THE ONE front door for both a live stub and a pure
expression; the DO has no configuration verb at all. **Fix:** replace every `itx.rewrite(m, t)`
with `itx.provide(m, t)` and drop "the edge verb `rewrite`" from the appendix row and the tree.

### A10. `docs/tutorial-build-the-iterate-context.md:775, 778, 779, 799, 824-829, 425, 387` — `itx.load(...).getEntrypoint()`

> `:775` `await itx.load(toolSource).getEntrypoint().run("hello");`

**True now:** exactly two loader doors — `itx.workers.get({ source, cacheKey?, className?, props? })`
and `itx.facets.get(name, { source, cacheKey?, className })`. Cloudflare's own `getEntrypoint()` /
`getDurableObjectClass()` survive only INSIDE `src/context/worker-loader.ts` and `built-ins.ts`.

**Fix:** `await itx.workers.get({ source: toolSource }).run("hello")`; the DO chain becomes
`itx.provide("itx.todos", ["itx","facets",["get","todos",{source,className:"TodoAppDurableObject"}]])`.

### A11. `docs/proposals/guard-audit.md` (whole file) — a commit plan against a source tree that no longer exists

The newest, untracked file in `docs/proposals/`, with **no status header at all** — so a reader
takes it as live work. Nine of the symbols and paths its DELETE table indexes have **zero**
occurrences anywhere in `src/` (verified by grep):

`INHERITED_BUILTINS` · `assertLiveValue` · `PROTOTYPE_FALLBACK_HOPS` · `#sweepPending` ·
`rpcStubAttach` · `EPHEMERAL_IDEMPOTENCY_KEY` · `#pendingDials` · `lendStubOverRelay` ·
`fetch-capabilities.ts`

It also indexes `routing.ts:100-101`, `capability-table.ts:53`, `capability-table.test.ts:302` and
`__workers-tests__/rpc-stub-sweep.test.ts` — all deleted — and `e2e/rpc-stubs-mounts-stay-offline-
until-revoked`, which does not exist. Its headline (`:12`) says "**~95 lines of speculative
guard** across 20 sites, of which five are worth a commit"; roughly half the plan is already
committed (`eb0bd718f`) and the other half aims at files that are gone. Note A (`:79-83`) asserts
"`lendStubOverRelay` reserves a transport … _before_ it calls `provider.dup()`" — the opposite is
true at HEAD (`rpc-stub-relay.ts:131` dups first, with that exact rationale in its comment).

**Fix:** re-head "> **HISTORY, written at `eb0bd718f`**; ~half is landed and ~half targets deleted
files — re-run the sweep before acting", or re-derive it against HEAD. The KEEP table's _reasoning_
is sound and worth salvaging; its line numbers are off by 17-50.

### A12. `docs/plan-argument-matched-mounts.md:3-9` — a false "LANDED" banner dated today

> **LANDED 2026-09-02** … Routing is ONE pure module, `src/context/routing.ts`, whose every rule is
> a row in `routing.test.ts`

**True now:** `src/context/routing.ts` and `src/context/capability-table.ts` are both DELETED (git
status `D`). The rules live in `src/context/itx-expression-rewriting.ts`, table-tested by
`itx-expression-rewriting.test.ts`. The doc cites `capability-table.ts:130-136` by line number ~20
times and writes `itx.load(src).getEntrypoint().run` as a target (`:47`). A "LANDED today" banner
is the strongest credibility signal in the tree, and it is false.

**Fix:** "> **LANDED 2026-09-02, then renamed**: `routing.ts` + `capability-table.ts` →
`context/itx-expression-rewriting.ts`; the verb is `provide`, not `route`."

---

## B. Significant — a reader is misled about how something works or what it is called

### B1. `docs/proposals/itx-surface-SYNTHESIS.md` — the "design record" argues for the API that lost

`docs/itx-surface-as-built.md:7` calls this file "the design record". §§1-8 (262 of 297 lines) are
the pre-decision proposal in the present tense; §9 is a bolt-on correction list. Nothing in the
header warns of that, and §9 itself carries three errors:

| line                      | says                                                                                         | true now                                                                                        |
| ------------------------- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `:14`                     | "the verb is `rewrite` … the word `routing.ts`'s own header already uses"                    | the verb is `provide`; `routing.ts` is deleted                                                  |
| `:54, 111, 138, 158, 163` | `itx.rpcStubs.lend(key, {stub})` / `.recall(key)`                                            | never shipped; `rpcStubs` is read-only (`get`/`list`) — **not retracted in §9**                 |
| `:96, 209`                | `subscribe → Promise<{name}>`, `rewrite → Promise<StreamEvent \| null>`                      | `subscribe → SubscriptionHandle`, `provide → RewriteRuleHandle`                                 |
| `:110`                    | key `itx.subscriptions.<name>`                                                               | `subscription:<name>`                                                                           |
| `:242-243`                | "`WorkerSource` already accepts `{ type: "inline", files: … }`"                              | that wrapper is gone                                                                            |
| `:267-268` **(in §9)**    | "one class per thing — `ProvidedRpcStubHandle` (`provide`), `RewriteRuleHandle` (`rewrite`)" | two handles; `ProvidedRpcStubHandle` never existed at HEAD — retracted 15 lines later at `:283` |
| `:271` **(in §9)**        | "`provide(rpcStubKey, stub, options?)` (positional stub; `options.rewrite` …)"               | `provide(match, target)`; no options bag                                                        |
| `:289` **(in §9)**        | "`load(src)` keeps `getEntrypoint` only"                                                     | `load` deleted entirely (`12d19384a`)                                                           |
| `:291-293` **(in §9)**    | "the producer-expression branch … deleted"                                                   | re-added behind `cacheKey` (`038f127a9`); §9 has no bullet recording it                         |

**Fix:** hoist §9's "ONE FRONT DOOR" paragraph into the header as a `> SUPERSEDED §§1-8` banner,
strike the retracted §9 bullets rather than leaving both readings standing, add a cacheKey bullet,
and stop `itx-surface-as-built.md:7` from calling it "the design record".

### B2. `docs/proposals/itx-surface-SYNTHESIS.md:19` — a layer order that contradicts LAYERS.md and the tutorial

> **Layer order**: stream → expressions/dispatch → rewrites → rpc stubs → subscriptions →
> processors

**True now:** rpc stubs come FIRST. That is the tutorial's chapter order
(`itx-surface-as-built.md:44-84`: 1 rpc stubs · 2 itx expressions · 3 rewrite rules ·
4 subscriptions · 5 processors), LAYERS.md's numbering (rpcStubs in layer 0, rewrite rules in
layer 2), and the reason `rpc-stub-directory.ts:2` says "Two layers, **in the order the tutorial
builds them**". SYNTHESIS inverts the two.

**Fix:** "rpc stubs → stream → itx expressions/dispatch → rewrite rules → subscriptions →
processors".

### B3. `docs/design-onion-subscriptions-processors.md:490` — `load` inside the range the header vouches for

Its header (`:3-12`) is the model the other docs lack: _"Sections 0-6 are kept in line with the
code AS BUILT … Sections 7-9 are the decision and sequence record and keep the names of their
day."_ But §6 breaks that guarantee:

> `:490` `// every DO built-in root (append · read · waitForEvent · fetch · whoami · kv ·
rpcStubs.get/list · rewriteRules · facets · subscriptions · load · runScript)`

**True now:** `workers`, not `load`. Same at `:18` and the `:50` mermaid node
`facets["facets · load (Worker Loader)"]`. **Fix:** s/`load`/`workers`/ at all three.

### B4. `docs/design-onion-subscriptions-processors.md:115-145` — the `BuiltInScope` block omits two doors

`:138` `facets: { get(name: string): FacetHandle; delete(name: string): void };` — no `spec`
overload, which is exactly the door `enableProcessor` targets, and which this doc's own `:26` calls
THE one door. The block also omits the `subscriptions` root entirely, contradicting its own `:112`
("the two READ views of core's slices, `rewriteRules` and `subscriptions`") and `:245-249`;
`workers.get` at `:142` is missing `cacheKey?`.

**Fix:** add the `facets.get(name, spec)` overload, the `subscriptions` root, and `cacheKey?`.

### B5. `docs/design-onion-subscriptions-processors.md:82, 130` — the "opaque key" doctrine, in the vouched-for range

> `:82` `// SUGAR: lends to rpcStubs under the opaque key + rule itx.robot ⇒ itx.rpcStubs.get('robot')`
> `:130` `/** THE physical registry. Keys are OPAQUE rpcStubKeys the lender picks…`

**True now:** the key IS the canonical match, so the rule is `itx.robot ⇒
itx.rpcStubs.get('itx.robot')`. The only key still "picked" is `subscription:<name>`. The doc's own
§3 (`:203-205`) states it correctly. Same drift in the tutorial at `:16-18` and `:715-724`
("`\"laptop\"` is an OPAQUE `rpcStubKey`"), where a whole passage teaches a distinction the code
collapsed.

**Fix:** "the key is the canonical match for `provide`, `subscription:<name>` for `subscribe`".

### B6. `docs/design-onion-subscriptions-processors.md:45-66` vs `LAYERS.md:17-164` — two live maps, two numberings

Design-onion: `L0 axioms · L1 rewrite rules · L2 subscriptions · L3 processors`. LAYERS:
`L0 axioms · L1 stream · L2 rewrite rules · L3 subscriptions · L4 processors · L5 edge`. Same
nouns, different numbers, both presented as current — "layer 1" means two different things
depending on which file you opened.

**Fix:** renumber design-onion to LAYERS.md, or say "layer numbers here are local to this doc".

### B7. `docs/clean-room-api-walkthrough.md:511` — the facet built-in without its load door

> `facets: { get(name: string): FacetHandle; delete(name: string): void };`

**True now:** `built-ins.ts:117-120` — `get(name, spec?: { source, cacheKey?, className })`. The
same doc gets it right at `:290`, `:869` and `:885`, so it contradicts itself.

**Fix:** restore the `spec?` parameter in the §4.4 signature and its prose.

### B8. `docs/clean-room-api-walkthrough.md:88, 1269, 1295` — the DO binding called `CONTEXT`

> `| `CONTEXT`| DO namespace →`IterateContextDurableObject` |`

**True now:** `env.ITERATE_CONTEXT` (`wrangler.jsonc:36`, `wrangler.test.jsonc:25`, `worker.ts:62`,
`itx-entrypoint.ts:29`). The rename is recorded as done at `itx-surface-as-built.md:410`.
**Fix:** s/`CONTEXT`/`ITERATE_CONTEXT`/ in all three.

### B9. `docs/clean-room-api-walkthrough.md:106, 1296, 1327, 1473` — `load` as a built-in root

> `:1327` `loop until the root is a built-in (kv, cd, load, facets, rpcStubs, ...)`

**True now:** the root is `workers`. §4.4 of the same doc documents `workers` correctly, so the doc
contradicts itself four times. **Fix:** replace `load` with `workers` at all four sites.

### B10. `docs/clean-room-api-walkthrough.md:98` — `rewrite` in the file map's verb list

> `cd · invoke · provide · rewrite · subscribe · enableProcessor · disableProcessor;`

**True now:** six members, no `rewrite`. **Fix:** drop `· rewrite`.

### B11. `docs/clean-room-api-walkthrough.md:1383-1384` — the wrong side un-sets a lent stub's rule

> disposing the handle (or the session ending) recalls the stub and appends
> `rewrite-rule-configured { match, target: null }` from the edge

**True now:** for a lent-stub `provide`, the handle's undo is `#sessionTeardown.dispose(key)` and
NOTHING else (`iterate-context.ts:237`) — the comment two lines above literally says "The rule is
NOT un-set by this session". The append comes from the DO's `#unsetWhatNamesRpcStub` on last-pager
close. Only an EXPRESSION rule's handle appends `null`. Correct at `:308-310` and `:359-362`.

**Fix:** delete "from the edge"; "…recalls the stub — the DO appends the un-set when the key's last
pager closes."

### B12. `docs/clean-room-api-walkthrough.md:296` — `disableProcessor` as two acts (A1 again)

> `subscription-configured { name, target: null }` + `itx.facets.delete(name)`, storage included

Correct at `:912` in the same file. **Fix:** "ONE event; the DO deletes the facet the removed row
hosted, storage included."

### B13. `docs/clean-room-api-walkthrough.md:1365, 1367` — the stub key changes spelling mid-diagram

> `Note over D: rewrite → itx.rpcStubs.get('robot').move(10)` /
> `E->>D: lendRpcStub({ rpcStubKey: "robot", stub })`

**True now:** `provide`'s key IS the canonical match — `"itx.robot"`, as the SAME diagram writes
three lines earlier. A sequence diagram is the one artefact readers trust to be mechanical.
**Fix:** `'robot'` → `'itx.robot'` in both lines.

### B14. `docs/plan-itx-surface-mirror-and-route-rename.md:3, 9, 17, 143` — today's date on a surface that never shipped

> `:3` 2026-09-02, for Jonas. … `:9` `itx.route(path, target)`, `itx.provide(path, { stub })`

**True now:** the `route`/`provide` split was rejected; one verb shipped, `provide(match, target)`,
positional, no options bag. `context/routing.ts` (`:38`) is deleted and the event that landed is
`itx/rewrite-rule-configured`, not `capability-table/route-added` (`:143-145`). Dated today,
present tense, no status line — a reader will hunt for `itx.route`. (The irony: `:11-12` of this
same file is the canonical statement of the fully-qualified-identifier rule — see C1.)

**Fix:** "> **SUPERSEDED same day** — one verb shipped: `provide(match, target)`."

### B15. Four unmarked snapshots + two mislabelled ones

| file                                                                                                                      | worst line                                                                                                                                                                                        | what is true                                                                                                                                                                                                              |
| ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PLAN.md:1, 4, 17, 64`                                                                                                    | "# Plan of record … **survives-compaction source of truth**"; `CapabilityTableProcessor`, slug `"capability-table"`; "itx.clients DIES: replaced by itx.contexts + a connections view"            | none of those exist; core is slug `core` v4.0.0; `:38` names `stream-durable-object.ts`, now `iterate-context-durable-object.ts`                                                                                          |
| `TIGHTENING.md:40, 60-61, 71`                                                                                             | "`stream-durable-object.ts` … `capability-table-processor.ts` · `core/itx-surface.ts`" as "the 3-4 core files"; `#liveFacets`; `configure()`                                                      | all three files gone; the field is `#liveFacetNames`; `configure()` deleted. **No date anywhere in the file.**                                                                                                            |
| `REVIEW-KENTON.md:16, 22, 64`                                                                                             | "**ONE pathProxy** (`core/expression.ts`)"; "**ONE confinedWorker** (`core/agent-runtime.ts`)"                                                                                                    | `src/core/` does not exist. **Zero dates in the file** (`grep 2026` returns nothing); written "All fixed below" in the perfect tense                                                                                      |
| `FACET-RPC-INVESTIGATION.md:13` vs `:63`                                                                                  | "throws 'Durable Object Facet stubs cannot be transferred…' in the clean-room `apps/project-worker`"                                                                                              | resolved 2026-08-05 (`:63`); the fix is a permanent rule at `dispatch.ts:37-43`. Stale path too (`packages/v3/project-worker`). A cold reader concludes facet RPC is broken                                               |
| `ACTION-PLAN.md:25, 30, 42` · `WALKING-SKELETON.md:12, 69` · `REFACTORS-LATER.md:14, 29` · `LAYERING-IDEATION.md:16, 148` | "PHASE 0 (DOING NOW)"; "**provideCapability({ path, type })** — mount at a callPath"; "the connections view returns a pathProxy"; "live capabilities ride ──▶ `SturdyRefTransport` (pager/relay)" | campaign closed 2026-08-28; verbs, mounts, connections, pathProxy all deleted; `SturdyRefTransport` is an invented noun that was never built                                                                              |
| `docs/plan-one-fetch-rules.md:12, 18, 189` · `docs/live-capnweb-ws-handler.md:8, 58, 234`                                 | "**Mounts carry NO policies.** capability-table 5.0.0 is `{path,target}`"; `"events.iterate.com/capability-table/capability-provided"`; "naming the mount … `/cap?cap=[…]`"                       | no mounts, no capability-table contract (core `4.0.0`); routes are `/version`, `/demo`, `/api`, `/expression`; `itx-durable-object.ts:488` is a renamed file. Both carry partial/buried status lines that read as current |
| `docs/proposals/itx-surface-{A,B,C,D}-*.md`                                                                               | none of the four says it is an option that lost; `C:3` even says "against today's tree"                                                                                                           | four options considered 2026-09-02; SYNTHESIS never names a winner (it merges), so no reader can learn from any of the five docs that A-D are dead ends                                                                   |

**Fix:** one `> **HISTORY (date).**` line at the top of each; for the four options, `> HISTORY — one
of four options considered 2026-09-02; see docs/itx-surface-as-built.md for what shipped.`

---

## C. Minor — sloppiness a careful reader trips on

### C1. `src/iterate-context.ts:78, 93` — `#undo`, a bare private field

```ts
readonly #undo: () => void;   // RewriteRuleHandle (:78) and SubscriptionHandle (:93)
```

The rule is stated in this repo's own words at `docs/plan-itx-surface-mirror-and-route-rename.md:11-12`:
"**Every other identifier carries the noun it holds or acts on** — `#borrowedRpcStubs`, never
`#borrowed`". `#undo` names a verb and no noun. It is the ONLY violation: all 97 other private
fields in non-test `src/` pass (`#borrowedRpcStubs`, `#pendingRpcStubPagerAttachments`,
`#closedRpcStubPagerSockets`, `#rpcStubPagesInFlight`, `#liveFacetNames`, `#coreReducedState`, …).

**Fix:** `#unsetRewriteRule` on `RewriteRuleHandle`, `#removeSubscription` on `SubscriptionHandle`.
(`SessionTeardown.#undoByKey` is fine — the key names what it holds.)

### C2. `docs/itx-surface-as-built.md` §4/§5/§7/§10 vs §11 — line counts recounted in one place only

The last commit (`44a286376`) is titled "as-built §11 recounted after the cacheKey commit". §11's
layer table is now right; the inline per-file counts elsewhere were not touched.

| claim                                               |       says |         is |
| --------------------------------------------------- | ---------: | ---------: |
| `:120` `src/iterate-context.ts, 355 lines`          |        355 |        352 |
| `:159` `src/context/built-ins.ts, 318 lines`        |        318 |        331 |
| `:222` `itx-expression-rewriting.ts, 201 lines`     |        201 |    **206** |
| `:335` `src/itx-entrypoint.ts, 55 lines`            |         55 |         57 |
| `:325` `sdk/stream-processor-durable-object.ts 103` |        103 |        104 |
| `:381` the-DO row of the §11 table                  |        667 |        674 |
| `:373` "6,293 in 36 files"                          | 6,293 / 36 | 6,287 / 34 |

§7's "201 lines" and §11's "206" are the same file in the same document. (Correct: `rpc-stub-
directory.ts` 350, `rpc-stub-relay.ts` 201, `stream.ts` 598, `core-processor.ts` 267,
`subscriptions.ts` 42, `subscription-delivery.ts` 379, `processor.ts` 560, `rpc-stub-fetch.ts` 286,
and every layer-table row except the DO.)

**Fix:** recount the six inline numbers, or delete them and keep only the §11 table.

### C3. `docs/clean-room-api-walkthrough.md:101` — "~600 lines" for a 674-line class. **Fix:** `~675`.

### C4. `src/sdk/index.ts:29-30` — a `provide` example that does not parse

> `itx.provide("itx.os", "itx.workers.get({ source, className: 'Remote', { props: { url } })")`

The braces are mismatched — the spec object closes before `props` is added. It reads like a
half-finished rewrite of `itx.load(src).getEntrypoint('Remote', { props: { url } })`.
**Fix:** `itx.provide("itx.os", "itx.workers.get({ source, className: 'Remote', props: { url } })")`.

### C5. `src/context/dotted-path-proxy.ts:139, 111` — "the capability table"

> `:139` A typo'd built-in (`itx.strems`) is a syntactically valid dynamic dispatch that fails at
> the capability table, not a crisp missing-method error

**True now:** `capability-table.ts` is deleted; the failure is `NO_ITX_EXPRESSION_MATCH` thrown by
`rewriteItxExpressionToBuiltIn` (`itx-expression-rewriting.ts:133`). **Fix:** "…fails with
`NO_ITX_EXPRESSION_MATCH` at the rewrite rules"; and `:111` "(the DO's dynamic table)" → "(the DO's
rewrite rules)".

### C6. `src/stream/live-state.ts:4` — a constructor call no call site makes

> a mini-app DO (a chatroom, a lobby) owns one directly — `new LiveState(itx, "chat", {…})`

**True now:** every real call site wraps the sink, because a field initializer cannot await
`env.ITX.get()` — `e2e/support/sources.ts:27` and `src/sdk/index.ts:41` both write
`new LiveState({ append: (e) => this.env.ITX.get().append(e) }, "chat", {…})`.
**Fix:** copy the sdk/index.ts spelling into this header.

### C7. `src/context/rpc-stub-directory.ts:19-22` — a key rule vaguer than the truth, plus dead machinery

> the edge's `provide` sugar uses whatever key it likes … connection metadata may attach to a pager
> record later

**True now:** `provide` uses the canonical match and `subscribe` uses `subscription:<name>` — those
are contracts, not "whatever it likes". "connection metadata" is residue of the deleted
`itx.connections` concept, naming machinery that does not exist. **Fix:** state the two key rules;
delete the "connection metadata" clause.

### C8. `src/context/expression.ts:12` — `ItxExpressionStep` is not exported

`docs/itx-surface-as-built.md:198` lists it as one of four codec types beside `ItxExpression`,
`ItxExpressionInput` and `ItxExpressionPrefix`; the other three are `export type`, this one is not.
An SDK reader who imports it gets a compile error. **Fix:** export it, or drop it from the table.

### C9. `docs/clean-room-api-walkthrough.md:331, 1145, 1439` — server-only builders in client examples

> `await itx.append(rewriteRuleConfiguredEvent("itx.db", "itx.kv"));`

`rewriteRuleConfiguredEvent` / `subscriptionConfiguredEvent` are not exported from
`src/sdk/index.ts`, and a capnweb client's whole dependency is capnweb. The doc gives the working
raw-event literal for rewrite rules at `:332-336` but never for subscriptions. **Fix:** label these
"in-worker spelling" and add the raw `subscription-configured` literal.

### C10. `docs/clean-room-api-walkthrough.md:1305, 737` — two omissions

`:1305` lists the loaded-isolate compat flags but omits `no_nodejs_compat_v2`
(`worker-loader.ts:147-150`). `:737` lists the SDK exports but omits `ProcessorStream`.

### C11. `src/iterate-context-durable-object.ts:35` — the verb list omits `disableProcessor`

> the edge's `provide`/`subscribe`/`enableProcessor` verbs build one and call `append`

**Fix:** add `disableProcessor` — it is the one verb whose commit triggers the DO's only
event-driven effect, described three lines later.

### C12. `docs/tutorial-build-the-iterate-context.md:1052` — the wrong subscription stub key

> a live callback is first lent to `itx.rpcStubs` (Chapter 1) under `itx.subscriptions.<name>`

**True now:** `subscription:<name>` (`iterate-context.ts:257`). **Fix:** one string swap.

### C13. `docs/tutorial-build-the-iterate-context.md:929` — a secret sentinel that would not substitute

> `headers: { Authorization: "Bearer {{secret:OPENAI_API_KEY}}" }`

**True now:** the pattern requires a scope segment (`project` | `platform`); a scope-less token is
left literal and forwarded. The doc's own edge snippet at `:918` passes scope `"project"`.
**Fix:** `{{secret:project:OPENAI_API_KEY}}`.

### C14. `docs/tutorial-build-the-iterate-context.md:591, 719, 1050, 1102` — event types without their namespace

Every real type is prefixed `events.iterate.com/`. A reader filtering `read(0)` on
`"itx/rewrite-rule-configured"` matches nothing. **Fix:** prefix them once and say so.

### C15. `docs/tutorial-build-the-iterate-context.md:6, 624-630, 596, 774, 823, 1095` — three smaller false claims

`:6` "Every snippet is real code" (false for most Chapter 1-3 client snippets); `:625` "it IS the
architecture … **with the production names**" followed by `:630` listing `provide · invoke ·
rewrite · fetch` and `:596` `itx.subscribers.*`, which never existed anywhere; `:1095`
`source: { type: "inline", files: { "counter.js": … } }` — the wrapper is gone AND the main module
must be named `"cap.js"` (`worker-loader.ts:105` throws otherwise).

---

## D. Tests, file names and the tutorial-order story

### D1. Four e2e files named for the deleted `itx.load` verb

| file                                                     | what it actually drives                                                         | rename to                                                                                    |
| -------------------------------------------------------- | ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `e2e/load-mid-chain-pipelining.e2e.test.ts` (`:7,50,67`) | `itx.facets.get('counterA', {source, className})` + `itx.workers.get({source})` | `facets-mid-chain-pipelining.e2e.test.ts`                                                    |
| `e2e/load-persistent-stub.e2e.test.ts` (`:17`)           | `itx.facets.get('keeper', {source, className})`                                 | `facets-persistent-stub.e2e.test.ts`                                                         |
| `e2e/load-remote-capnweb.e2e.test.ts` (`:33`)            | `itx.workers.get({source, className:'Remote', props:{url}})`                    | `workers-remote-capnweb.e2e.test.ts` (+ the two refs in `e2e/support/global-setup.ts:20,26`) |
| `e2e/load-sources.e2e.test.ts`                           | `["itx","workers",["get",{source}],["run",21]]` + `itx.runScript`               | `workers-and-facets-sources.e2e.test.ts`                                                     |

Plus `e2e/load-sources.e2e.test.ts:60` — `test("the load door takes the modules INLINE, and
runScript(lambda) sugar")` — there is no load door. **Fix:** `"itx.workers.get takes the modules
INLINE, and runScript(lambda) sugar"`; and `:6` "INLINE at the load site" → "at the
workers.get / facets.get site".

### D2. `e2e/fetch-door-dynamic-live-ws.e2e.test.ts:2` — a factually false header

> Provider worker A (loaded via `itx.load`) PROVIDES a live RpcTarget

`:98` is `itx.workers.get({ source: SRC_PROVIDER }).run(mode)`.
**Fix:** "(loaded via `itx.workers.get({ source })`)".

### D3. `__workers-tests__/alarm-quiesce.test.ts:5` — a "Target surface" line naming a dead field

> Target surface: `IterateContextDurableObject.alarm()/#recordActivityForQuietClock/#liveFacets/#facetWorkInFlight`

The field is `#liveFacetNames` (`iterate-context-durable-object.ts:362`). The other three names are
correct, so a reader greps for the one that does not exist. **Fix:** `#liveFacetNames`.

### D4. `e2e/processor-facet-folds-and-address.e2e.test.ts:1` — the header names a different file

> `// processor-facet-reduces-and-address.e2e.test.ts — THE FACET SPINE live`

The file on disk is `…-folds-…`; the header and all four titles say "reduces". "folds" is the
pre-rename word. **Fix:** rename the file (the header is already right).

### D5. `e2e/rpc-stubs-bare-function-across-clients.e2e.test.ts:10` — a title showing a 3-arg `provide`

> `test("client A: provide('itx.runOnMyComputer', async fn, rewrite) · client B: …")`

The body calls `laptop.provide("itx.runOnMyComputer", async (cmd, args) => …)`. The trailing
`rewrite` is the deleted second door. **Fix:** drop `, rewrite` from the title.

### D6. `e2e/rewrite-rules-map-and-chains.e2e.test.ts:49` — a title naming the deleted verb

> `test("a NON-CANONICAL match spelling through the rewrite door is stored CANONICAL and rewrites")`

The body calls `itx.provide(" itx.ghost", "itx.whoami")`. **Fix:** "…through the **provide** door…"
(and the body comment at `:50`).

### D7. `e2e/support/client.ts:15, 18, 130` — three stale helper docstrings, one an orphan

`:18` is a docstring with **no declaration under it** — `/** The /cap door for `cap`in`ctx`, as
http or ws. */` immediately followed by `expressionUrl`'s own docstring. `/cap` is deleted (this
lane's own `fetch-door-expression…:107` asserts `/cap` now returns help text). `:15` says the raw
doors are "(/cap, /version)"; they are `/version`, `/demo`. `:130` `presence()` says "a mount never
does" — mounts are deleted. **Fix:** delete the orphan; `(/version, /demo)`; "…a rewrite rule never
does (it is pure data)."

### D8. `e2e/session-doors.e2e.test.ts:3` — header advertises a deleted source root

> …disableProcessor, **the repo**.

Nothing in the file touches a repo; its own body comment at `:24` says "the files/repo roots died in
increment 57". **Fix:** drop `, the repo`.

### D9. `e2e/rewrite-rules-tour.e2e.test.ts` — a file name that understates by 8×

Its header says _"the itx surface, toured end to end"_ and its one title is `"itx tour: …"`. The
eight sections cover `whoami`, `kv`, lent stubs, the rule map, dynamic-worker rules, presence /
fan-out and `/version` — rewrite rules are one of eight. **Fix:** `itx-surface-tour.e2e.test.ts`.

### D10. `src/context/dotted-path-proxy.test.ts:107-144` — mounts as fixture vocabulary

`someMount`, `mount`, and `:122` `// (mounted capabilities legitimately expose it)`. Mounts are
deleted. **Fix:** `someLentStub`; "(a lent rpc stub's surface legitimately exposes it)".

### D11. `e2e/context-dotted-calls-fall-back-to-the-table.e2e.test.ts:92, 101` — vacuous pins

Both tests end `expect(String(err.message ?? err)).toBeTruthy()`. `rejection()` already throws if
the promise resolves or hangs, so the assertion adds nothing; the titles ("REJECTS", "also
rejects") are carried entirely by the helper. **Fix:** assert the shape actually claimed
(`expect(err.message).toMatch(/not a method|no rewrite rule/)`), or drop the `expect`.

### D12. `tutorial-proof/` — a gitignored harness pinning a surface that is gone

`.gitignore` is one line: `tutorial-proof/`. Nothing in `package.json` runs it. Its headers are the
most confidently wrong text in the package:

- `fragments/level2-claims.ts:11,48,51,53` imports the deleted `ProvidedRpcStubHandle` and pins
  `IterateContext["rewrite"]`. It is also **not valid TypeScript** (`:47` reads
  `Extends<unknown; rewrite?: ItxExpressionInput, Parameters<…>[1]>`) — it can never have compiled.
- `fragments/level5-stream-ctor.ts:12-13` pins `StreamDeps["admit"]` / `["reduceAtCommit"]`; the
  real deps are `{ storage, path, projectId, onCommit }` — it contradicts the doc's own correct
  snippet at `:1068-1073`.
- `fragments/level4-do-snippet.verbatim.ts:17` pins `RpcStubDirectory#fetch` (real:
  `acceptRpcStubPagerWebSocket`) and a one-key `{ hooks }` ctor (real: `{ hooks, onPresence,
rpcStubFetch }`). It is an expected-fail fixture, so `run.sh` asserts a drifted failure shape.
- `platform/ch1-load-todo.test.ts:77,88,95,109,127` pins `itx.load(…).getEntrypoint()`,
  `getDurableObjectClass('TodoAppDurableObject')` and `itx.rewrite(…)`.
- `platform/ch1-provide.test.ts:6-7` claims "**RE-POINTED 2026-09-02** to the post-refactor surface:
  `provide(rpcStubKey, stub, { rewrite })`" — that 3-arg form is exactly what was deleted, and the
  body calls it (`:33`, `:46`). Same in `ch2-fetchcap-tunnel.test.ts:142,184,213`.
- `platform/vitest.config.ts:2` cites `__tests__/harness.ts`, which does not exist.
- Every proof header cites "**Level N**" and hard line numbers ("tutorial lines 144-159", "L62-66")
  — the doc has no Levels (it is Part 0 + Chapters 1-4) and those numbers land on unrelated prose.
  This is also the cross-test anchor-pinning the repo forbids.

**Fix:** delete `fragments/` and `platform/`, or re-point `platform/*` into `e2e/` as real
`<primitive>-<claim>.e2e.test.ts` files against `provide` / `workers.get` / `facets.get`.

### D13. The tutorial-order story, contradicted in three places

The order of record is **rpc stubs → itx expressions → rewrite rules → subscriptions → processors**
(`itx-surface-as-built.md:44-84`, LAYERS.md's numbering, `rpc-stub-directory.ts:2`).

1. `proposals/itx-surface-SYNTHESIS.md:19` puts rewrites BEFORE rpc stubs (B2).
2. `docs/design-onion-subscriptions-processors.md:1` titles the onion
   "rpcStubs → rewrite rules → subscriptions → processors" — dropping **itx expressions**, the
   chapter that makes `invoke` make sense.
3. `docs/tutorial-build-the-iterate-context.md:765-841` teaches step (3) before step (2): Chapter
   1's "Durable names" section goes straight to the loader and rewrite rules, and itx expressions
   appear only as a parenthetical at `:782`, AFTER the section that depends on them — while the
   chapter subtitle claims "Part 0's bricks 1-6, done properly".

**Fix:** add `→ itx expressions` to the design-onion title, fix SYNTHESIS row 9, and split a short
"itx expressions" section before "Durable names" in Chapter 1.

---

## E. Checked and found accurate

**Source — headers, docstrings and inline comments all match the code:**
`src/worker.ts` · `src/session.ts` · `src/itx-entrypoint.ts` · `src/context/built-ins.ts` ·
`src/context/worker-loader.ts` · `src/context/expression.ts` · `src/context/dispatch.ts` ·
`src/context/invoke-handle.ts` · `src/context/rpc-stub-relay.ts` ·
`src/context/durable-object-names.ts` · `src/stream/stream.ts` · `core-processor.ts` ·
`subscriptions.ts` · `subscription-delivery.ts` · `processor.ts` · `events.ts` ·
`reduce-checkpoint.ts` · `src/sdk/stream-processor-durable-object.ts` · `src/lib/errors.ts` ·
`patch.ts` · `timeout.ts` · `logs.ts` · `src/fetch/rpc-stub-fetch.ts` (its four doctrine points and
the WORKAROUND fence are honest about being parked) · `wrangler.jsonc` · `wrangler.test.jsonc` ·
`knip.json`.

**Names:** 97 of 99 private fields in non-test `src/` obey the fully-qualified rule; `#undo` (C1) is
the only violation. No invented framework nouns survive in `src/` — `SessionScopedHandle` and
`LiveValue` are gone, and `SturdyRefTransport` appears only in `LAYERING-IDEATION.md`.

**Error messages:** all 40 thrown strings in non-test `src/` name current spellings. The only
near-miss is `no facet "<name>" — load a class into it first`
(`iterate-context-durable-object.ts:443`), where "load" is plain English, not the deleted verb —
leave it.

**Docs that say what they are:** `ARCHITECTURE.md`, `docs/iterate-context.md`,
`ITX-KERNEL-SHAPE.md` and `docs/state-of-play.md` all carry the same honest four-line
`**⚠️ SUPERSEDED.**` banner at lines 1-4 — confirmed. (Caveat: it points readers at `LAYERS.md`,
which A1 shows is wrong.) `DEFECTS.md:7-9` fences its stale bodies. `FIX-LOG.md:3` is an explicit
append-only log. `docs/capnweb-upgrade-answer.md` is self-dating and about the fork rather than our
surface (only `/cap?ctx=` at `:88` is stale). `docs/design-onion-subscriptions-processors.md:3-12`
has the best header in the tree — the model the other docs should copy — though §§0-6 do not fully
honour it (B3-B6) and §10 sits outside both its guarantees.

**Tests whose name, header and every title accurately describe the body (48):**
e2e — `context-built-ins-and-error-codes`, `cursor-delivery-halts-ladders-and-resumes`,
`fetch-door-egress-missing-secret-502`, `fetch-door-expression-http-and-websocket`,
`fetch-door-tunnel-to-localhost`, `live-state-chains-client-side`,
`processor-facet-breaker-pauses-the-stream`, `processor-facet-enable-disable-lineage`,
`push-delivery-no-dropped-warns`, `push-delivery-ranges-chain`, `push-delivery-throughput`,
`rewrite-rules-argument-pinned`, `rpc-stubs-callback-fires-back`,
`rpc-stubs-lend-recall-and-offline`, `rpc-stubs-reconnect-same-path`, `rpc-stubs-rich-values`,
`rpc-stubs-slack-bridge`, `session-lends-per-context`, `session-wire-frames-one-round-trip`,
`stream-chunked-bodies`, `stream-core-reduce`, `stream-idempotency-pause-paging`,
`stream-wait-for-event`, `stream-woken-and-inline-live-state`, `subscriptions-ephemeral-opt-in`;
e2e/support — `live-client.ts`, `log-harness.ts`, `setup.ts`, `solo-config.ts`, `sources.ts`,
`targets.ts`; `__workers-tests__` — `do-doors`, `ephemeral-offset-reuse`, `facet-props`,
`hibernation-at-scale`, `rpc-pipelining`, `rpc-stub-pager-attach`, `stream`, `ws-fetch-live-101`,
`support.ts`; unit — `dispatch`, `durable-object-names`, `expression`, `rpc-stub-relay`,
`worker-loader`, `fetch/egress`, `lib/patch`, `stream/core-processor`, `stream/events`,
`stream/live-state`, `stream/processor-rules`, `stream/processor`, `stream/subscriptions`.

**Cross-checks clean across every lane:** no `itx.connections` / `connect()`, no `itx.mounts`, no
`env.CONTEXT`, no `contextName` prop, no `ProvidedRpcStubHandle`, no `itx.processors.list()` /
`itx.rewrites.list()`, no `itx.subscriptions.<name>` as a stub key (every occurrence is the correct
`subscription:<name>`), no `capability-table.ts` / `routing.ts` imports, no `.skip`/`.only`/`.todo`,
and every `src/**.ts` path cited in a test header resolves to a real file.
