# Narrative and layering — round 2, `packages/v3/project-worker`, 2026-09-04

> Read against the working tree at `c09629162` (today's ten commits, `bccbaec0a..HEAD`), the five
> `BUILD-LOG.md` entries dated 2026-09-04 (lines 2623–3282), `docs/itx-surface-as-built.md` (the
> surface of record), `docs/clean-room-api-walkthrough.md`, `docs/tutorial-build-the-iterate-context.md`,
> `docs/design-onion-subscriptions-processors.md`, and the module headers of `src/context/*.ts`,
> `src/library/*.ts`, `src/app-config.ts`, `src/iterate-context.ts`, `src/iterate-context-durable-object.ts`.
> Every `@`/print/parse/resolve claim was RUN against the real codec and resolver (`tsx`, scratchpad
> `worked-examples.ts`); every test-title pin was grepped. Nothing was edited. Format follows
> `2026-09-02-narrative-failures.md` and `2026-09-02-layering.md`.

## Summary

1. **The surface of record contradicts itself on the one doctrine today's headline commit
   introduced.** §5 says "the platform never spells a short name … a lent stub's rule, a processor's
   row are all `itx.builtins.…`" (line 174–176) — and §4's three verb rows (146–148), §6 (265), §9
   (390) and §12 (507) still spell `itx.rpcStubs.get('<match>')` / `itx.facets.get(name, spec)`. The
   code spells `itx.builtins.…` in every event the proxy writes (`iterate-context.ts:236-241, 285,
   328-342, 363`). The same stale spelling is in 6 docstrings of the two files that write the
   events, in the walkthrough's §9.2 diagram, in the tutorial's "read the log and that is exactly
   what you'll see" (:748 — it is not), and 6 times in the design doc. **≈30 of the 73 rows below are
   this one spelling.**
2. **The un-set of a dead stub's rule is described as `null` in four places and is not `null` in the
   code.** The DO appends `rewriteRuleRemovedEvent` = `{ match, target: "itx.builtins.<match…>" }`
   (`iterate-context-durable-object.ts:187`, `itx-expression-rewriting.ts:315-318`); an expression
   handle's dispose appends the same (`iterate-context.ts:381`). Under today's rule 5 a `null` at a
   built-in root is a MASK — a reader who copies §6 line 264 or walkthrough :1413 would turn a dead
   fake `itx.ai` into a denial of the real one. §7 line 312–314 of the same doc says it right.
3. **The biggest arc of the day is absent from the doc of record.** Three of ten commits are memory
   hygiene (an 8 MiB append ceiling, byte-budgeted pages, `atHead`, ONE typed SQL storage module,
   `REDUCE_CHECKPOINT_TOO_LARGE`, the in-flight ledger). `itx-surface-as-built.md` has zero
   occurrences of `atHead`, `EVENT_TOO_LARGE`, `stream-storage`; §5's `readEvents` row and the
   walkthrough's four `StreamPage` listings omit `atHead`; §11's error-code list lacks three codes;
   §11's layer table lacks six new files. §8 still says contract `4.0.0` and "zod `record`s" — the
   contract is `6.0.0` and hand-written (`core-processor.ts:168-172, 227`).
4. **Layering holds where it was claimed and leaks in one place nobody claimed.** The library
   boundary is real (one importer, the boundary test); the DO has no configuration verb; the
   builtins-rooted hot path reads no table; reduce → resolver is one arrow, no cycle. The leak: the
   SDK processor HOST — first-party code bundled into every loaded isolate — spells
   `env.ITX.get().append(…)` / `.readEvents(…)` (`sdk/stream-processor-durable-object.ts:84-85`), so a
   hosted processor's emits, catch-up and gap-repair go through the CONTEXT'S RULES while the push to
   it is at the fixed point. A whole-context override (green in `rewrite-rules-builtins-root.e2e:139`)
   redirects every processor's own log traffic. "The whole facet-push path, every platform-spelled
   append" (BUILD-LOG, rule 5) covers half the path.
5. **The `BuiltInScope` docstring — the canonical doc of the kernel surface — still says
   "built-in first; no rule"** (`built-ins.ts:88-89`), eighty lines under a header that says rules
   first. The rule-table test fixture still lists `load` as a root (`itx-expression-rewriting.test.ts:4, 20`
   — 09-02 finding A5, never applied), and its depth-budget title says "32 rules resolve, 33 trip"
   while its body proves 31 and 32.

**Rows: 73 mismatches** (surface 23 · walkthrough 20 · tutorial 5 · design 8 · src headers, docstrings
and test titles 17), **70 of them NO-BRAINER** (a doc edit with the true text already in this file
or the same file; the three that are not — S11, W20, D1 — each need one written paragraph).
**Layering findings: 8** (2 actionable, 1 optional split, 5 confirmations).
**BUILD-LOG claims: 45 spot-checked, 36 pinned, 6 unpinned by nature, 3 soft.**

---

## A. Mismatches

Columns: **id** · **where** · **what it says** · **what is true (evidence)** · **the exact fix** · **NB** = NO-BRAINER
(a doc edit; the true text is quoted). Severity in the id suffix: `!` critical (a reader copies it and it is
wrong or contradicts the same file), `+` significant, no mark = minor.

### A1. `docs/itx-surface-as-built.md` — the surface of record

| id | where | says | true | fix | NB |
| --- | --- | --- | --- | --- | --- |
| S1 `!` | §4 line 146, `provide` row | "the rule `match ⇒ itx.rpcStubs.get('<match>')` RIDES the pager upgrade" | the proxy builds `["itx","builtins","rpcStubs",["get", match]]` (`iterate-context.ts:236-241`); §5 line 174–176 of this doc says so | `match ⇒ itx.builtins.rpcStubs.get('<match>')` | NB |
| S2 `!` | §4 line 147, `subscribe` row | "its row (target `itx.rpcStubs.get('subscription:<name>')`)" | `["itx","builtins","rpcStubs",["get", rpcStubKey]]` (`iterate-context.ts:285`) | `itx.builtins.rpcStubs.get('subscription:<name>')` | NB |
| S3 `!` | §4 line 148, `enableProcessor` row | "target `itx.facets.get(name, { source, className }).processEventBatch`" | `["itx","builtins","facets",["get", name, spec],"processEventBatch"]` (`iterate-context.ts:328-342`) | `itx.builtins.facets.get(name, { source, className }).processEventBatch` | NB |
| S4 `!` | §6 line 263–265 | "UN-SET by the DO on the key's LAST pager close: `rewrite-rule-configured { match, null }` for every rule" | the DO appends `rewriteRuleRemovedEvent(rule.match)` = `{ match, target: "itx.builtins.<match…>" }` (`iterate-context-durable-object.ts:187`; `itx-expression-rewriting.ts:315-318`). A `null` would be a MASK under a built-in root (rule 5) — §7 line 312–314 says exactly this | "`rewrite-rule-configured { match, target: 'itx.builtins.<match…>' }` (the removal spelling — never `null`, which would mask a platform row) for every rule, and `subscription-configured { name, null }` for every subscription" | NB |
| S5 | §6 line 265 | "every subscription whose target is `itx.rpcStubs.get('<key>')`" | compared RESOLVED: `print(resolve(target).at(-1)) === "itx.builtins.rpcStubs.get('<key>')"` (`…durable-object.ts:171-183`) | "whose target RESOLVES to `itx.builtins.rpcStubs.get('<key>')`" | NB |
| S6 `!` | §10 lifetimes, line 425 | "a rule for an expression … dies when: handle disposed, or the session ends (the handle appends `null`)" | `#removeRuleInBackground` appends `rewriteRuleRemovedEvent(match)` only if the row still holds this handle's target (`iterate-context.ts:371-383`) | "(the handle appends the removal spelling `itx.builtins.<match…>`, and only if the row is still its own)" | NB |
| S7 `!` | §5 line 190, `facets` row | "`.get(name)` · `.get(name, {…})` · `.delete(name)`" | `BuiltInScope.facets = { get }` (`built-ins.ts:160`); "there is no delete verb" (`built-ins.ts:159`, `…durable-object.ts:655`); `#deleteFacet` is private | delete "· `.delete(name)`"; add "(no delete: a facet leaves with the row that hosted it, §9)" | NB |
| S8 `!` | §8 line 350 | "`CoreStreamProcessor` (slug `core`, contract `4.0.0`)" | `version: "6.0.0"` (`core-processor.ts:227`); §12 line 534 of this doc says 6.0.0 | `6.0.0` | NB |
| S9 | §8 line 363 | "The whole state is plain JSON (zod `record`s and arrays)" | "HAND-WRITTEN (no zod on the edge/DO script)" (`core-processor.ts:168-172`) | "plain JSON (hand-written types, no zod on this script)" | NB |
| S10 `+` | §5 line 184, `readEvents` row | "`→ { events, scannedThroughOffset }`" | `StreamPage` is `{ events, scannedThroughOffset, atHead }` and the SERVER cuts the page by bytes (8 MiB) or 1000 rows; `limit` only shrinks it (`stream.ts:44-53, 59-66, 459-466`) | "`→ { events, scannedThroughOffset, atHead }` — a page is cut by the server's byte budget or `limit`; `atHead` says whether the durable mark was reached" | NB |
| S11 `+` | §8, §11 line 481–483, §11 table, §12 | no mention of the memory-hygiene arc (3 commits: `94f315ae6`, `ce503fdc1`, `8b99eb39e`); error codes listed: 9; layer table: 34 files | `EVENT_BODY_MAX_CHARS = 8 MiB` with coded `EVENT_TOO_LARGE` (`stream.ts:59, 310`); `stream-storage.ts` (220 lines, ONE typed SQL module); `REDUCE_CHECKPOINT_TOO_LARGE` (`reduce-checkpoint.ts:99`); `EVENT_UNREADABLE`; in-flight ledger 16 MiB (`subscription-delivery.ts:57,60`); `atHead`; grep of this doc for `atHead|EVENT_TOO_LARGE|stream-storage`: 0 hits | add a "Decided on 2026-09-04, done (memory hygiene)" block to §12 (the BUILD-LOG's three bullets, condensed); one paragraph to §8 (ceiling, budgeted page, storage module); the three codes to §11; rows for `stream/stream-storage.ts` (220), `stream/node-sqlite-durable-object-storage.ts` (41), `library/*` (648), `app-config.ts` (166), `context/built-in-roots.ts` (38) | — |
| S12 | §11 line 453–465; §6/§8/§9 headers | "3,903 code lines … 6,186 raw in 34 files … Tests: unit + workers 252; e2e 141" (recounted 2026-09-03); "kept in one place, the table below, and nowhere else" | today: 5,879 code lines, 9,140 raw, 42 non-test files (excl. generated); BUILD-LOG arc four: unit+workers 384p/12xf, e2e local 168p/2xf/10sk. The counts ALSO live in three section headers (`350 · 201`, `598 · 267`, `42 · 379` → now 398 · 232, 656 · 384, 42 · 655) | recount into the table; delete the counts from the §6/§8/§9 headers so the "one place" claim is true | NB |
| S13 | §4 line 145 | "`invoke(call: ItxExpressionInput)`" | `invoke(call: ItxExpressionInput, ...args: unknown[])` (`iterate-context.ts:173`); §3 line 125 says so | `invoke(call, ...args)` | NB |
| S14 | §7 line 321–323 | "A live stub behind a pinned match (`rewrite-rules-argument-pinned.e2e`): `provide("itx.ai.run('gpt-5')", fn)`" | that e2e was re-spelled onto `itx.llm` (BUILD-LOG arc two; `e2e:11-20` provides `itx.llm.run('special')`) because `itx.ai` is a root and its `null` would mask | spell the example on `itx.llm.run('special')`, or keep `itx.ai` and drop the citation | NB |
| S15 | §7 line 337 | "Misha's test (`rewrite-rules-builtins-root.e2e`): `provide("itx.ai", fake)`" | that file's Misha test shadows `itx.whoami` (`e2e:35`); the `itx.ai` version is `ai-root-shadow-and-fable.e2e.test.ts:45` | cite `ai-root-shadow-and-fable.e2e` | NB |
| S16 | §7 rule 7, line 305 | "`query: { model: 'claude-x', ...@ }` cannot be talked out of its model" | true — but the STORED form prints keys sorted: `{query:{...@,model:'claude-x'}}` (run: `print(parse(…,{holes:true}))`), and JS spread semantics read the doc's order as "the caller wins" | spell it `{ ...@, model: 'claude-x' }` — what the log shows and what JS means (same in `itx-expression-rewriting.test.ts:218`, `ai-root-shadow-and-fable.e2e:121` as inputs) | NB |
| S17 | §7 line 325–335 | "`rewriteRules.resolve("itx.greeter.hello()")` returns exactly these four lines" with `rule itx.greeterA ⇒ itx.rpcStubs.get('greeterA')` | the four lines are right FOR A HAND-WRITTEN short rule (run: identical output); no test pins them through `rewriteRules.resolve` (the unit pin uses `…get('a')`, `itx-expression-rewriting.test.ts:311-323`; the e2e pin resolves `itx.store.get('k')`, `rewrite-rules-builtins-root.e2e:116`); the tour provides `itx.greeterA` as a LIVE stub, whose `provide`-written chain is THREE lines with key `itx.greeterA` | add "(a hand-written rule; a `provide(stub)` rule is already `itx.builtins.…`, and its chain is three lines)" | NB |
| S18 | §2 line 63 | "`itx.rpcStubs.get('itx.laptop').ping()` // — the physical door" | `itx.rpcStubs` rides the implicit platform row; the physical door is `itx.builtins.rpcStubs.…` (§5 line 173 of this doc) | `itx.builtins.rpcStubs.get('itx.laptop').ping()` | NB |
| S19 | §5 line 198–199 vs `built-ins.ts:4-6` vs `built-in-roots.ts:25-28` | doc: two groups = ROOTS vs THE LIBRARY; `built-ins.ts` header: two kinds = AXIOMS vs BINDINGS, "code a user could write is neither"; `built-in-roots.ts` lists the library verbs AS roots | three files, three partitions of one record (`buildBuiltIns` spreads `buildLibrary(libraryItx)` in, `built-ins.ts:386`) | `built-ins.ts:4-6`: "Three kinds of key, one record: the AXIOMS (log, registry, table, hosts, addressing), the BINDINGS (`kv`, `ai`), and THE LIBRARY (`connectTo*`, src/library/ — code a user could write, taking only `itx`)" | NB |
| S20 | §10 line 447 | "`live-46 poc <version id>`" | `CODE_VERSION = "live-47"` (`worker.ts:48`); the label is hand-bumped per deploy | "`<label> poc <version id>`, e.g. `live-47 poc 7474bb76-…`" | NB |
| S21 | §12 line 507 ("C, done", 09-02) | "`enableProcessor`'s target is `itx.facets.get(name, spec).processEventBatch`" | since 09-04: `itx.builtins.facets.get(name, spec).processEventBatch`; hosting decided on the RESOLVED target | append "(spelled `itx.builtins.facets…` since 09-04)" | NB |
| S22 | header line 3 | "the review commit of 2026-09-02" | the doc records four 2026-09-04 arcs (§12) | "as of 2026-09-04" | NB |
| S23 | §9 line 390 | "(`itx.facets.get(name, { source, className })…`, the shape `enableProcessor` writes)" | `enableProcessor` writes `itx.builtins.facets…`; the reduce marks `hostedFacet` on the RESOLVED target, so a user's short spelling hosts too (`core-processor.ts:84-97, 320-328`) | "a target that RESOLVES to `itx.builtins.facets.get(name, spec)…` — the platform's spelling from `enableProcessor`, or a user's short one" | NB |

### A2. `docs/clean-room-api-walkthrough.md`

| id | where | says | true | fix | NB |
| --- | --- | --- | --- | --- | --- |
| W1 | :105 (the tree) | "the kernel roots: whoami, kv, append, read, waitForEvent, …" | `readEvents`; `ai` is a root (`built-in-roots.ts:13, 15`) | `…, kv, ai, append, readEvents, …` | NB |
| W2 | :110 (the tree) | "itx-expression-rewriting.ts THE RULES 1–5 (match / pick / apply / rewrite-to-built-in)" | RULES 1–7; the loop ends at the fixed point `itx.builtins` (`itx-expression-rewriting.ts:11-50`) | "THE RULES 1–7 (match / pick / apply / rules-first to the fixed point `itx.builtins` / the door / `@`)" | NB |
| W3 | :100–101 | "One class, ~675 lines" | 790 raw lines | drop the count | NB |
| W4 `!` | :267 (`provide` docstring) | "`match ⇒ itx.rpcStubs.get('<match>')`, un-set by the DO" | `itx.builtins.rpcStubs.get('<match>')` (S1) | as S1 | NB |
| W5 `!` | :279 (`subscribe` docstring) | "targeted as `itx.rpcStubs.get('…')`" | `itx.builtins.rpcStubs.get('subscription:<name>')` (S2) | as S2 | NB |
| W6 | :260, :1238 | `invoke(call: ItxExpressionInput): Promise<unknown>` | `invoke(call, ...args)` on both the proxy (`iterate-context.ts:173`) and the DO (`…durable-object.ts:674`) | add `...args: unknown[]` | NB |
| W7 `+` | :349–352 | "`provide` with a live stub builds the rule event first…, lends the stub, then appends the rule… If the DO refuses the rule (a paused stream), the lend is recalled and the refusal propagates" | the rule RIDES the pager upgrade (`x-itx-rpc-stub-pager = { rpcStubKey, appendEvents }`); the DO appends it as it accepts the socket; a refusal is the upgrade's 409 and leaves nothing lent — nothing to recall (`iterate-context.ts:231-248`; `rpc-stub-directory.ts:25-30`). This doc's own §9.2 diagram (:1386–1387) says so | "`provide` with a live stub builds the rule event first (a spelling the codec refuses throws with nothing lent), then opens the pager with the event IN the upgrade; the DO accepts the socket and appends the rule in one turn. A refusal (a paused stream) is the upgrade's 409 + code: nothing was lent, no socket, no row." | NB |
| W8 | :356–357 | "un-sets every rule and subscription whose target is `itx.rpcStubs.get('<rpcStubKey>')`" | compared resolved to `itx.builtins.rpcStubs.get(…)`; the rule un-set is the removal spelling (S4, S5) | as S4/S5 | NB |
| W9 | :435–440 | "What read() returns on every hop. `interface StreamPage { events; scannedThroughOffset }`" | `readEvents`; `StreamPage` has `atHead: boolean` (`stream.ts:48-53`) | rename; add `atHead: boolean; // the scan reached the durable mark` | NB |
| W10 | :480–483 | `read(afterOffset?, limit?): Promise<{ events; scannedThroughOffset }>` in the `BuiltInScope` listing | `readEvents(afterOffset?, limit?): Promise<StreamPage>` (`built-ins.ts:116`) | rename + `StreamPage` | NB |
| W11 `!` | :129, :600 | "contract 4.0.0" | `6.0.0` (S8) | `6.0.0` | NB |
| W12 | :619–623 (`CoreState` comment) | "a configured target REPLACES, null DELETES"; `target: ItxExpression; // a lent stub's is itx.rpcStubs.get('<rpcStubKey>')` | `null` is KEPT as a mask under a built-in root, deletes elsewhere; the platform-equivalent target deletes; `target: ItxExpression \| null` (`core-processor.ts:181-185, 284-302`); a lent stub's is `itx.builtins.rpcStubs.get(…)` | "REPLACES; null MASKS under a built-in root (kept as a row), deletes elsewhere; the target `itx.builtins.<match…>` deletes"; `target: ItxExpression \| null`; builtins spelling | NB |
| W13 | :1128 | "heals a range gap with `read(through)`" | `readEvents(through)` | rename | NB |
| W14 | :1229–1238 (DO listing) | `read(...): { events; scannedThroughOffset }`; "rewrite through the current rules until the root is a built-in"; `invoke(call)` | the DO's method IS `read` (kept, internal — correct) but returns `StreamPage` with `atHead`; rules FIRST until rooted at `itx.builtins` (this doc's :1357 says so); `invoke(call, ...args)` | add `atHead`; "RULES FIRST, until the call is rooted at `itx.builtins` (a bare built-in root is the implicit platform row)"; `...args` | NB |
| W15 | :1283–1286 (`Context` listing) | `read(...): Promise<{ events; scannedThroughOffset }>` | `ReachableContext.read` is right (kept); returns `StreamPage` (`atHead`) | add `atHead` | NB |
| W16 `!` | :1386, :1392 (§9.2 diagram) | `target: "itx.rpcStubs.get('itx.robot')"`; "rewrite → itx.rpcStubs.get('itx.robot').move(10)" | `itx.builtins.rpcStubs.get('itx.robot')`; ONE rewrite lands at the fixed point | both to `itx.builtins.rpcStubs.get('itx.robot')` | NB |
| W17 `!` | :1413–1414, :1419 | "`rewrite-rule-configured { match, target: null }` for every rewrite rule and every subscription whose target is `itx.rpcStubs.get('<rpcStubKey>')`"; "Only an EXPRESSION rule's handle appends the `null` itself" | S4/S6: the rule un-set is `{ match, target: "itx.builtins.<match…>" }` (a `null` would MASK a root); the handle appends the same removal spelling (`iterate-context.ts:381`); subscriptions do get `{ name, target: null }` | as S4 + "Only an EXPRESSION rule's handle appends the removal spelling itself" | NB |
| W18 | :377 (codec docstring copy) | "`itx.rpcStubs.get('cam')(1, 2)` … what a rewrite rule spells when a lent stub is called with args" | the platform's rule spells `itx.builtins.rpcStubs.get('cam')(1, 2)` (a user's may not) | "what a `provide(stub)` rule spells: `itx.builtins.rpcStubs.get('cam')(1, 2)`" | NB |
| W19 | :1503 (vocabulary) | "`itx.rpcStubs.get(rpcStubKey)` is how a rule or a subscription names it" | a user's rule may; the platform's rows spell `itx.builtins.rpcStubs.get(…)` and the un-set compares RESOLVED | "…names it (the platform spells it `itx.builtins.rpcStubs.get(…)`; any spelling that resolves there counts)" | NB |
| W20 `+` | whole file | — | grep for `atHead`, `EVENT_TOO_LARGE`, `REDUCE_CHECKPOINT_TOO_LARGE`, `stream-storage`, `byte-budget`: 0 hits — the memory-hygiene arc is missing here too (S11) | one paragraph in §5 (the stream) + the two codes in the errors table; `stream-storage.ts` in the tree | — |

### A3. `docs/tutorial-build-the-iterate-context.md`

| id | where | says | true | fix | NB |
| --- | --- | --- | --- | --- | --- |
| T1 | :38–40 | "the edge verb `rewrite(match, target \| null)` was deleted and absorbed into `provide`" | true — an explicit GONE note | no change (listed because the brief asked for every `rewrite(`) | — |
| T2 | :396–397, :410–412 | `LOADER.get(...).getEntrypoint()` in the toy | Cloudflare's own Worker Loader API, labelled as such at :410; the deleted itx two-step is not meant | no change | — |
| T3 `!` | :466 | "The real platform has ONE table … `itx.shell ⇒ itx.rpcStubs.get('itx.shell')`" | `itx.shell ⇒ itx.builtins.rpcStubs.get('itx.shell')` (S1) | builtins spelling | NB |
| T4 | :547, :607 vs :621 | the toy stream and toy DO expose `read(afterOffset = 0)`; the prose says "`readEvents(0)` shows your rewrite rules were events all along" | the toy's method is `read`; the platform root is `readEvents` (`built-ins.ts:116`) | rename the toy DO's root to `readEvents` (keep the stream's `read`, as the platform does) — or write "`read(0)` (the platform spells it `readEvents`)" | NB |
| T5 `!` | :635–636 | "a live `provide(match, stub)` also appends an ordinary rule whose target is the expression `itx.rpcStubs.get('<match>')`" | `itx.builtins.rpcStubs.get('<match>')` | builtins spelling | NB |
| T6 `!` | :746–748 | "`target: "itx.rpcStubs.get('itx.runOnMyComputer')"`. Read the log and that is exactly what you'll see" | the log holds `itx.builtins.rpcStubs.get('itx.runOnMyComputer')` (`iterate-context.ts:236-241`) — the sentence promises the log and is wrong about it | `target: "itx.builtins.rpcStubs.get('itx.runOnMyComputer')"` (:743 and :750 are user spellings and may stay) | NB |
| T7 `!` | :869 | "Lending a live stub is that same rule with the target `itx.rpcStubs.get('<match>')`" | `itx.builtins.rpcStubs.get('<match>')` | builtins spelling | NB |

### A4. `docs/design-onion-subscriptions-processors.md` (header: "Sections 0–6 are kept in line with the code AS BUILT")

| id | where | says | true | fix | NB |
| --- | --- | --- | --- | --- | --- |
| D1 `+` | :216–224 (§3) | "Built-ins first; then the most SPECIFIC matching rule … repeating until the root is a built-in … `null` DELETES it" | RULES FIRST; the fixed point is `itx.builtins`; the implicit platform row; `null` MASKS under a built-in root (`itx-expression-rewriting.ts:27-35`); grep of this doc for `builtins`: 0 hits | one paragraph (rule 5 verbatim), or drop "kept in line with the code AS BUILT" for §3 | — |
| D2 | :125–129 (§2 `BuiltInScope`) | `read(afterOffset?, limit?)`; no `ai`, no `connectTo*` | `readEvents`; `ai` and the three library verbs are roots (`built-in-roots.ts`) | rename; add the four roots with one-line docstrings | NB (rename) |
| D3 `!` | :56 (mermaid), :86, :137, :228, :328, :522 | `provide` writes `match ⇒ itx.rpcStubs.get('<match>')`; `subscribe` writes `itx.rpcStubs.get('subscription:<name>')` | `itx.builtins.rpcStubs.get(…)` in every case (S1, S2) | builtins spelling, six places | NB |
| D4 | :108 | "`read(through)` fills the hole" | `readEvents(through)` | rename | NB |
| D5 `!` | :238 | "contract 4.0.0" | `6.0.0` | `6.0.0` | NB |
| D6 | :515, :519 | "every DO built-in root (append · read · waitForEvent · fetch · whoami · kv · rpcStubs.get/list · rewriteRules · facets · subscriptions · workers · runScript)"; `invoke(call)` | `readEvents`; plus `ai`, `connectToMcp`, `connectToOpenApi`, `connectToCapnweb`; `invoke(call, ...args)` | rename, add four, `...args` | NB |
| D7 | :228–230 | "The rule dies with the stub: the handle's dispose un-sets it from the edge, and when the key's LAST pager closes the DO un-sets…" | for a LIVE stub the handle only recalls the stub; the DO alone un-sets (`iterate-context.ts:249-255`) | "the handle's dispose recalls the stub; the DO un-sets what named it when the key's last pager closes" | NB |
| D8 | :28, :114, :158 (`load(...)`, `getEntrypoint`); :577, :581, :648 (`getEntrypoint(name, { props })`, `facets.delete`) | the first three say "as built: gone" — fine; the last three are §7–9 plan rows that "keep the names of their day" | `facets.delete` (:581) was later deleted from the surface (S7) | annotate :581 "(later deleted — a facet leaves with its row)" | NB |

### A5. Module headers, docstrings and test titles in `src/`

| id | where | says | true | fix | NB |
| --- | --- | --- | --- | --- | --- |
| E1 `!` | `src/context/built-ins.ts:88-89` (`BuiltInScope`, "the canonical doc of the kernel surface") | "the physical-layer roots a context resolves `itx.<root>…` against DIRECTLY (itx-expression-rewriting.ts, built-in first; no rule)" | RULES FIRST; a short `itx.<root>` reaches the record through the implicit platform row unless the context's table says otherwise — the same file's header, lines 7–11, and rule 5 | "the physical-layer roots — `itx.builtins.<root>` runs against them directly; `itx.<root>` reaches them through the implicit platform row unless the context's table says otherwise (itx-expression-rewriting.ts, rule 5: rules FIRST)" | NB |
| E2 `!` | `built-ins.ts:129-132` (`rpcStubs` docstring) | "configures the pure-data rule `match ⇒ itx.rpcStubs.get('<match>')`" | `itx.builtins.rpcStubs.get('<match>')` (S1) | builtins spelling | NB |
| E3 | `built-ins.ts:1-6` (header) | roots list omits the three library verbs the record spreads in; "Two kinds of root … Code a user could write is neither" | S19 | S19's sentence | NB |
| E4 | `src/context/itx-expression-rewriting.ts:323` (`#builtIns` docstring) | "keys (kv, append, read, cd, …)" | `readEvents` | rename | NB |
| E5 `!` | `src/context/itx-expression-rewriting.test.ts:4, 20` | "Built-in roots for the table: kv, whoami, rpcStubs, load, ai"; `new Set(["kv", "whoami", "rpcStubs", "load", "ai"])` | `load` is not a root (`BUILT_IN_ROOTS`, `built-in-roots.ts:10-29`); no row uses it; 09-02 finding A5, never applied | drop `load` in both places | NB |
| E6 | `itx-expression-rewriting.test.ts:301` (title) | "the depth budget: a chain of 32 rules naming rules resolves, 33 trips" | the body: `chainOf(31)` resolves ("31 rules + the platform row = 32"), `chainOf(32)` trips (:308–309); the BUILD-LOG says 31/32 | "32 REWRITES resolve (31 rules + the platform row), 33 trip" | NB |
| E7 `!` | `src/iterate-context.ts:82-85` (`RewriteRuleHandle` docstring) | "for an expression, by appending `null`" | `#removeRuleInBackground` appends `rewriteRuleRemovedEvent(match)` — the removal spelling — and only if the row still holds this handle's target (:366–384) | "for an expression, by appending the removal spelling (`itx.builtins.<match…>`) when the row is still its own" | NB |
| E8 `!` | `iterate-context.ts:200-202` (`provide` docstring) | "the pure-data rule `match ⇒ itx.rpcStubs.get('<match>')` is appended" | the code twenty lines down (:235–241) and the file header (:23) spell `itx.builtins.rpcStubs.get('<match>')` | builtins spelling | NB |
| E9 `!` | `iterate-context.ts:262-264` (`subscribe` docstring) | "lent to `itx.rpcStubs` under the key `subscription:<name>` and targeted as `itx.rpcStubs.get('…')`" | :285 spells `itx.builtins.rpcStubs.get('subscription:<name>')` | builtins spelling | NB |
| E10 `!` | `iterate-context.ts:315-316` (`enableProcessor` docstring) | "the target `itx.facets.get(name, spec).processEventBatch`" | :328–342 spells `itx.builtins.facets.get(name, spec).processEventBatch` | builtins spelling | NB |
| E11 | `src/iterate-context-durable-object.ts:253-257` | "`itx.facets.get(name, { source, className })…`, the shape `enableProcessor` writes" | `enableProcessor` writes `itx.builtins.facets…`; the method reads `hostedFacet`, set by the reduce on the RESOLVED target (its own body comment, :264–266) | "a row whose target RESOLVED to `itx.builtins.facets.get(name, spec)…` at configure time (`hostedFacet`)" | NB |
| E12 | `…durable-object.ts:160-161` (`onPresence` comment) | "every subscription whose target is `itx.rpcStubs.get('<key>')`" | compared resolved (the next method's comment, :171–172) | "whose target RESOLVES to `itx.builtins.rpcStubs.get('<key>')`" | NB |
| E13 | `src/context/expression.ts:8-11` | "`itx.rpcStubs.get('cam')(1, 2)` is `["itx","rpcStubs",…]` — what a rewrite rule spells when a lent stub is called with args" | the platform's rule spells `itx.builtins.rpcStubs.get('cam')(1, 2)` | "what a `provide(stub)` rule spells: `itx.builtins.rpcStubs.get('cam')(1, 2)`" | NB |
| E14 | `src/context/invoke-handle.ts:50-51` | "a live client owns its offset (it chains delivered ranges and heals with read)" | `readEvents` | rename | NB |
| E15 | `src/library/index.ts:27-29` | `type LibraryItx = Pick<IterateContext, "fetch">` (a type import from the EDGE class) | the library is handed an `InvokeHandle` over the DO's own `invoke` (`built-ins.ts:302-304`), i.e. the RECORD's `fetch`; the import points up the onion (library → iterate-context.ts → built-ins.ts → library: a type cycle) | `Pick<BuiltInScope, "fetch">` (type import from `../context/built-ins.ts`) | NB |
| E16 | `library/index.ts:5-6`, `boundary.test.ts:1-5`, `built-ins.ts:188-189` | "a library module … could move to a userspace worker unchanged" | `capnweb.ts` imports `InvokeHandle` (`library/capnweb.ts:13`), which `src/sdk/index.ts` does not export — it could not move unchanged today; `mcp.ts` and `openapi.ts` could | "unchanged (capnweb.ts once the SDK exports `InvokeHandle`)" | NB |
| E17 | `e2e/itx-surface-tour.e2e.test.ts:70` (comment) | "ordinary rows whose target is `itx.rpcStubs.get('<rpcStubKey>')`" | `itx.builtins.rpcStubs.get(…)`; the helper it calls accepts both spellings (`e2e/support/client.ts:135-141`) | builtins spelling | NB |

Out of scope but the same rows: `LAYERS.md:63` (contract 4.0.0), `:87, :113, :126` (`itx.rpcStubs.get`
as what the platform writes).

---

## B. Layering findings, with evidence

### L1 — The library boundary holds (confirmation)

- One importer outside the folder: `src/context/built-ins.ts:28-38` (`buildLibrary` + types). `grep -rn "library/" src` finds
  nothing else but comments (`worker.ts:29`, `built-in-roots.ts:25`).
- Runtime imports inside the folder: `capnweb` (`mcp.ts:10`, `openapi.ts:11`, `capnweb.ts:11`), `../context/invoke-handle.ts`
  (`capnweb.ts:13`); everything else type-only. `library/boundary.test.ts:12-16` pins the allow-list.
- Two caveats, both narrative (E15, E16): the `itx` type is taken from the edge class, and `capnweb.ts` needs a platform
  primitive the SDK bundle does not export, so "movable unchanged" is two-thirds true.

### L2 — The proxy never spells a short name in an event it writes; the SDK processor host does (actionable)

Proxy, every event it writes:

| verb | expression written | file:line |
| --- | --- | --- |
| `#append` (every verb's write) | `["itx","builtins",["append", event]]` | `iterate-context.ts:361-363` |
| `provide(match, stub)` | rule target `["itx","builtins","rpcStubs",["get", match]]` | `:236-241` |
| `subscribe({ target: fn })` | row target `["itx","builtins","rpcStubs",["get", "subscription:<name>"]]` | `:285` |
| `enableProcessor` | row target `["itx","builtins","facets",["get", name, spec],"processEventBatch"]` | `:328-342` |
| handle undo (expression rule) | reads `itx.builtins.rewriteRules.get(match)`, appends `rewriteRuleRemovedEvent` (target `itx.builtins.<match…>`) | `:371-383`; `itx-expression-rewriting.ts:315-318` |
| DO's own appends (presence, un-set, halted) | `this.append(…)` / `stream.append` — bypass the resolver | `…durable-object.ts:155-159, 187-190` |

The hole: `src/sdk/stream-processor-durable-object.ts:84-85` —

```ts
append: (...events) => this.env.ITX.get().append(...events),
read: (after, limit) => this.env.ITX.get().readEvents(after, limit),
```

`env.ITX.get()` is the edge `IterateContext` RpcTarget; `.append`/`.readEvents` are the prototype hop → `invoke(["itx",["append",…]])` → the
DO resolves `itx.append` THROUGH THE CONTEXT'S RULES. So a hosted processor's emits (`processor.ts:515`), its catch-up and gap-repair reads
(`processor.ts:276, 304, 396`) and its live-state deltas go through the user's table, while the platform's push TO the processor is at the
fixed point. A whole-context override `provide("itx", stub)` — pinned green in `e2e/rewrite-rules-builtins-root.e2e.test.ts:139` ("`builtins`
still reaches its log") — or a mask `provide("itx.readEvents", null)` silently redirects or denies every running processor's own log traffic.
BUILD-LOG (builtins entry, and rule 5 in the header: "the whole facet-push path, every platform-spelled append") covers the push half only.

Decide one of two: (a) it is intended — a hosted processor is userspace and should see the table (then say so in rule 5, in the SDK host's
header at `:19-20`, and in §5 of the surface doc: "a facet's own `append`/`readEvents` resolve through the table; spell `itx.builtins.…` to
bypass"); or (b) the host is platform code and its engine port spells `this.env.ITX.get().builtins.append(...)` /
`.builtins.readEvents(...)` — two lines; the author's own `itx` inside `processEvent` stays short. (b) matches the doctrine as written.

### L3 — The DO carries no configuration verb (confirmation)

Public members of `IterateContextDurableObject`: `append`, `waitForEvent`, `read`, `invoke`, `fetch`, `alarm`, `webSocketMessage/Close/Error`,
`rpcStubTransportState` (probe), `lendRpcStub` (transport). Every configuration is an event built on the edge and appended, or carried in the pager
upgrade and appended by `acceptRpcStubPagerWebSocket` through `#appendAndRunCommittedEffects` (`…durable-object.ts:145-149, 242-251`). The one
event the DO appends on its own initiative is the un-set (`#unsetWhatNamesRpcStub`, `:170-193`); the one effect it runs off a committed event is
the facet delete (`:260-280`). Header `:33-41` says exactly this.

### L4 — Nothing reads the rule table on the builtins-rooted hot path (confirmation, one note)

- `resolveItxExpression` returns at `:229` before touching the `rules` thunk; pinned by "a builtins-rooted call NEVER reads the table"
  (`itx-expression-rewriting.test.ts:326`). `ItxExpressionResolver.invoke` (`:350-369`) does no other table read.
- The effective-table materialization (`#rewriteRuleList`, `…durable-object.ts:298-315`: every row printed + `BUILT_IN_ROOTS` filtered) runs
  only for `rewriteRules.list/get` — including one `get` per expression-handle undo (`iterate-context.ts:374-379`). Not hot.
- Note: `#unsetWhatNamesRpcStub` (`:170-193`) runs `resolve` on EVERY rule and row target on every last-pager close, each `resolve` re-reading
  the thunk (`rulesList ??= rules()` is per call). O(rows × chain) per detach; fine today (no test has more than 300 rows), worth one line in
  the header so nobody "optimizes" it into a cache with the wrong lifetime.

### L5 — Reduce ↔ resolver: one arrow, no cycle; one transitive pull and one two-clock hazard

- Imports: `stream/core-processor.ts:33-38` → `context/built-in-roots.ts` (`isBuiltInRoot`) and `context/itx-expression-rewriting.ts`
  (`resolveItxExpression`, `BUILTINS_ROOT`, the rule type). `itx-expression-rewriting.ts:61-76` imports `lib/*`, `context/dispatch.ts`,
  `context/expression.ts` and `type StreamEventInput` only. The 09-02 arrow (rewriting → core-processor, for `CoreContract`) is reversed and gone —
  BUILD-LOG's "a cycle would have followed" is right. `built-in-roots.ts` is a genuine leaf (no imports).
- (a) Transitive pull, optional split: the "pure, total" rules module also houses `ItxExpressionResolver`, which needs `callOn`/`walkSteps`
  (`:64`) → `dispatch.ts` → `invoke-handle.ts` → `capnweb`'s `RpcTarget`. So the stream's inline reduce (`stream.ts` → `core-processor.ts` →
  rewriting) now loads the evaluator and capnweb for a pure fold. The ONE-file doctrine ("the rules, the one event, the resolver") is the cause.
  If it ever matters (the unit lane runs the reduce in Node today, so it does not yet): move the class to `dispatch.ts` — it is the evaluator's
  front door — and the rules file becomes a leaf like `expression.ts`.
- (b) Two clocks on "does this row host a facet": the reduce decides `hostedFacet` ONCE, at configure time, through the rules of that moment
  (`resolveThroughState`, `core-processor.ts:87-97, 320-328`); the DO's removal effect reads that frozen marker (`:264-278`); the M1 memo
  recovery re-resolves the stored target through the CURRENT rules (`:528-537`); delivery re-resolves at every push. A rule change after
  configure (`provide("itx.facets", null)`, or a user rule re-pointing `itx.facets`) makes the three readers disagree: the row still says
  "hosts", delivery lands elsewhere or is refused, recovery finds no spec. Only the forward direction is pinned ("a hosting target that cannot
  resolve yet … hosts nothing", `core-processor.test.ts:507`). Either state the rule in §9 ("hosting is a configure-time fact; re-configure to
  re-decide") or drop the marker and re-derive on read. The doc-of-record sentence "Hosting is decided on the RESOLVED target" (§12 line 533)
  should say WHEN.

### L6 — The two vocabularies are kept apart in names and files (confirmation, two deliberate crossings)

- Physical: `rpcStubKey`, `lendRpcStub`, `BorrowedRpcStub`, `LentRpcStub`, `RpcStubHandle`, `RpcStubDirectory`, `rpc-stub-relay.ts`,
  `rpc-stub-directory.ts`, presence events. Data: `ItxExpressionRewriteRule`, `rewriteRuleConfiguredEvent`, `rewriteRuleRemovedEvent`,
  `rewriteRules`, `RewriteRuleHandle`, `itx-expression-rewriting.ts`. No file mixes them; no name does.
- Crossing 1, at the wire: the pager attach request carries `appendEvents: StreamEventInput[]` (`rpc-stub-directory.ts:40-52`) — the physical
  layer TRANSPORTS data-layer events, opaque, type-only import, and hands them to the DO's `appendEvents` dep (`…durable-object.ts:145-149`).
  Correct: the parent owns both ends; the directory never reads a rule.
- Crossing 2, at the DO: `#unsetWhatNamesRpcStub` bridges presence (physical) → rule/row removal (data). It lives in the parent, as it should.
- One name that reads across: `provide(stub)` returns a `RewriteRuleHandle` whose dispose recalls the STUB and un-sets NO rule (the DO does,
  later, on the last pager close — `iterate-context.ts:249-255`). Name = data, act = physical. The docstring (`:82-85`) explains it; acceptable,
  but E7 must be fixed for that docstring to be true in its other half.

### L7 — Two predicates for "is a built-in root" (note)

The reduce uses the constant list (`core-processor.ts:33, 92, 145` — `isBuiltInRoot`); the resolver uses the record's own keys
(`itx-expression-rewriting.ts:340-342` — `Object.hasOwn(this.#builtIns, root)`). They are tied at the TYPE level (`built-ins.ts:205-213`) and by
`satisfies BuiltInScope` on the record (`:387`), not at runtime; a key that reaches the record by spread without joining the list would resolve
at the DO and not mask in the reduce. Low risk, worth one line in `built-in-roots.ts`'s header.

### L8 — Configuration is a leaf and stays one (confirmation)

`src/app-config.ts` imports nothing; read by the DO constructor (`…durable-object.ts:137`) and `/version` (`worker.ts:57`); `deployId` is handed
DOWN into `buildBuiltIns` and `loadConfinedWorker` as a string, never the binding (`:323, 558`). §10 of the surface doc matches the module
line for line (row table, five parsers, unknown-var refusal, WeakMap memo, the two fields).

---

## C. BUILD-LOG 2026-09-04 — claims vs pins

Three-plus claims per entry, each with the pin (a test title, a grep) or UNPINNED.

### Memory hygiene (`## 2026-09-04 — memory hygiene …`, lines 2623–2937, three sub-entries)

| claim | pin |
| --- | --- |
| `Stream.read` is byte-budgeted at 8 MiB / 1000 rows; `limit` only shrinks | `stream.ts:63, 66` (`READ_PAGE_BUDGET_BYTES`, `READ_PAGE_MAX_EVENTS`); `stream-storage.ts:174` counts `length(CAST(body AS BLOB))` |
| `EVENT_BODY_MAX_CHARS = 8 MiB`, coded `EVENT_TOO_LARGE` | `stream.ts:59, 310`; `lib/errors.ts:17`; node lane `memory-budget.test.ts:34` (`--max-old-space-size`) |
| `highestDurableOffset` → `atHead: boolean` | `stream.ts:51` |
| ONE typed SQL module, `readEventPage(after, limit, budgetBytes)` over `DurableObjectStorageSlice`; the node shim is 41 lines | `stream-storage.ts:22, 165`; `wc -l node-sqlite-durable-object-storage.ts` = 41 |
| `REDUCE_CHECKPOINT_TOO_LARGE` measured BEFORE the write | `reduce-checkpoint.ts:99`; `errors.ts:18` |
| in-flight and pending totals tightened 32 → 16 MiB; per-row 8 MiB | `subscription-delivery.ts:51, 57, 60` |
| `READ_OUTSTANDING_BUDGET_BYTES` 32 MiB, floor 512 KiB, 5 s retire | `stream.ts:77-79` |
| `LIVE_STATE_PATCH_MAX_CHARS` 1 MiB, `patch: null` re-seed | `live-state.ts:27-32` |
| the 4-way alarm-pass limiter is GONE | `grep CURSOR_PASS_CONCURRENCY src` = 0 |
| degradation e2e is deployed-only (`test.skipIf` on a local URL) | `stream-uncontrolled-degradation.e2e.test.ts:41` |
| "the deployed isolate tolerates ~150 MiB for one request and kills at ~290"; "384 MiB in 65 pages" | UNPINNED — measurements from probes, no test asserts them (by nature) |

### The pager upgrade carries the rule (lines 2938–2971)

| claim | pin |
| --- | --- |
| rule/row offset below the key's `rpc-stub/attached`, for `provide` and `subscribe` | `e2e/rpc-stubs-attach-carries-the-rule.e2e.test.ts:49, 69` |
| atomic refusal on a paused stream; the resume path | same file `:88`; `__workers-tests__/rpc-stub-pager-attach.test.ts:68` (409 + `STREAM_PAUSED`, no socket, no presence, no rule) |
| a malformed header is a 400 | `rpc-stub-pager-attach.test.ts:45` |
| `attachRpcStubPager` deleted; `do-doors` pins the verb gone | `grep attachRpcStubPager src` = 0; `__workers-tests__/do-doors.test.ts:160` |
| "Round trips per `provide(stub)`: 3 → 1" | UNPINNED — no test counts edge→DO hops; `session-wire-frames-one-round-trip.e2e` counts client↔edge capnweb frames, a different hop. The offset-order pin is indirect evidence only |

### The builtins root (lines 2972–3069)

| claim | pin |
| --- | --- |
| a builtins-rooted call never reads the table | `itx-expression-rewriting.test.ts:326` (a throwing thunk) |
| the law `invoke(call) ≡ invoke(resolve(call).at(-1))`, unit and end to end | unit `:691`; e2e `rewrite-rules-builtins-root.e2e.test.ts:110` |
| masks kept/deleted/no-op; platform-equivalent delete; hosting on the resolved target; cannot-resolve hosts nothing | `core-processor.test.ts:393, 436, 476, 507` |
| e2e file (6): Misha, deny, effective table, resolve+law+args, whole-context override, the door | six titles at `:29, :62, :91, :110, :139, :170` |
| `e2e/support/client.ts`'s helper accepts either registry spelling | `client.ts:140` (`/^itx\.(builtins\.)?rpcStubs\.get\(/`) |
| "the depth budget (31 rules + the platform row = 32)" | the BODY of `itx-expression-rewriting.test.ts:301-310` agrees; its TITLE says "32 rules … 33 trips" (E6) |
| hot-path microbenchmarks (0.13 µs / 2.36 µs / 0.01–0.04 µs) | UNPINNED — scratch measurement, no test |

### Arc two: `@`, `itx.ai`, `readEvents` (lines 3070–3112)

| claim | pin |
| --- | --- |
| `'@cf/…'` and `'a@b.c'` inside quotes untouched; nested `@`/`...@` with two or none refused; codec round trip | `itx-expression-rewriting.test.ts:196-200, 274-291, 404` |
| e2e: Misha on the real root, the dream, the gateway shape, the door, deployed-only inference | `ai-root-shadow-and-fable.e2e.test.ts:45, 79, 115, 141, 160` |
| `AI` bound in wrangler.jsonc, NOT in wrangler.test.jsonc | `wrangler.jsonc:41`; `grep '"ai"' wrangler.test.jsonc` = 0 |
| `rewrite-rules-argument-pinned.e2e` re-spelled onto `itx.llm` | `e2e/rewrite-rules-argument-pinned.e2e.test.ts:11-15` |
| the SDK host's engine port renamed to `readEvents` | `sdk/stream-processor-durable-object.ts:85` |
| "LOC: expression.ts 97 → 162, rewriting 192 → 248" | UNPINNED (not recounted here; today's raw lines 231 / 370) |

### Arc three: the library tier (lines 3113–3191)

| claim | pin |
| --- | --- |
| boundary pinned; SDK bundle is capnweb's workerd build; `newWorkersRpcResponse` exported; `/expression/<path>` suffix; capnweb brands registered | `library/boundary.test.ts`; `build-sdk.mjs:37`; `sdk/index.ts:33`; `worker.ts:81`; `worker.ts:32-33` |
| library code lines index 34 · mcp 185 · openapi 176 · capnweb 112 | recount (non-blank, non-comment): 34 · 185 · 176 · 112 — exact |
| E2E "(7)" local, 10 deployed | 10 `test(`, 3 of them `skipIf(LOCAL)` (`:138, :157, :195`) — matches "LOCAL 7p/3sk" |
| "`mcp.test.ts` 12 rows; `openapi.test.ts` 16 rows; `capnweb.test.ts` 4 rows" | SOFT — capnweb 4 exact; mcp = 4 `test(` + a 7-row table = 11; openapi's table rows are multi-line and not reproducible by a count. Not wrong enough to chase; say "rows" or give `test(` counts |

### Arc 3b: the real pet shop (lines 3192–3219)

| claim | pin |
| --- | --- |
| `apps/dummy-petshop/src/capnweb.ts` + `capnweb.test.ts` (6) | files exist; 6 `test(` |
| the pnpm override `'@iterate-com/dummy-petshop>capnweb'` | `pnpm-workspace.yaml:98` |
| the connector e2e depends on `PETSHOP_BASE_URL` (default the deployed shop); fixtures deleted from `sources.ts` | `e2e/library-connectors…:16`; `grep mcpServer\|openapiServer\|capnwebServer e2e/support/sources.ts` = 0 |
| petshop e2e "+4" capnweb tests | `describe("capnweb door (/capnweb)")` at `petshop.e2e.test.ts:220`; the count of 4 not verified |
| "Deployed to prd as version 6a3738e6 (smoke ok)" | UNPINNED — deploy log |

### Arc four: `app-config.ts` (lines 3220–3282)

| claim | pin |
| --- | --- |
| the engine over every parser kind; "the table has exactly the rows the worker reads"; memoizes per env; throws at first use naming the var | `app-config.test.ts:72-75, 99, 115, 125` |
| `/version`'s three words pinned in the tour | `e2e/itx-surface-tour.e2e.test.ts:175-180` |
| `worker-loader.test.ts` hands `deployId` in; `dispatch.test.ts` pins the coded root-apply | `worker-loader.test.ts:48, 72, 104`; `dispatch.test.ts:90-92` |
| the delivery loop's deterministic-halt rule sees `NOT_A_METHOD` | `subscription-delivery.ts:66-72` |
| `app-config.ts` 97 code lines | recount = 97 |
| "16 rows" in the engine table | SOFT — the table has 12 rows (`vars:` entries) + 5 named tests |
| "`/version` = `live-47 poc 7474bb76-…`, the deploy id equal to wrangler's Current Version ID" | UNPINNED — deploy log (the shape is pinned, the values are not) |

**Totals:** 45 claims checked · 36 pinned · 6 unpinned by nature (isolate ceilings, a hop count, microbenchmarks, a LOC delta, two
deploy logs) · 3 soft (row counts that a `test(` count does not reproduce: mcp/openapi rows, the pet shop's "+4", app-config's "16").

---

## D. What to do first (the coordinator's order)

1. One `sed` across the four docs and two source files for the platform-written spelling: `itx.rpcStubs.get('<match>')` /
   `('subscription:<name>')` / `itx.facets.get(name, spec).processEventBatch` → `itx.builtins.…` where the sentence says the PLATFORM wrote it
   (S1–S3, S21, S23, W4, W5, W8, W12, W16, W17, W19, T3, T5–T7, D3, E2, E8–E13, E17). Leave user spellings (`provide("itx.shell", "itx.rpcStubs…")`) alone.
2. The un-set is the removal spelling, never `null` (S4, S6, W17, E7) — the one row set that would make a reader write a mask.
3. `4.0.0` → `6.0.0`; "zod" → hand-written; `.delete(name)` out of §5 (S7–S9, W11, D5).
4. `BuiltInScope`'s docstring and the test fixture's `load` (E1, E5, E6) — the two places a reader of the code goes first.
5. The memory-hygiene arc into the doc of record (S10, S11, W9, W10, W14, W15, W20) — a paragraph, three codes, six table rows.
6. Decide L2 (the SDK host's short spelling) and L5(b) (when hosting is decided); write the answer into rule 5 / §9.
