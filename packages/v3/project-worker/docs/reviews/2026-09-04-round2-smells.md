# Smells review, round 2 — 2026-09-04 (reduce and clean)

> One reviewer over today's ten commits (`bccbaec0a..c09629162`: the pager-carries-the-rule arc, the
> builtins root, `@`/`itx.ai`/`readEvents`, THE LIBRARY tier, the pet-shop capnweb door, the app
> config), read against the owner's standing doctrines — radical simplicity, delete speculative
> machinery, ONE door per concern, no framework, fully qualified names, a docstring on every named
> type, rule modules as ONE pure file + a table test, a SMALL codec, no backcompat cruft, the platform
> never spells a short name. Every `file:line` is against HEAD `c09629162` (the working tree is being
> edited by other agents; nothing under `src/` was touched by this review). The memory-budget arc's
> areas (`src/stream/*`, budgets, ledger) are out of scope except where they duplicate something here.
> Two claims were MEASURED rather than asserted: the codec cut (S2) was run as a corpus of 32 parse,
> 11 print and 5 paren cases against the current lexers copied verbatim (scratchpad
> `lexer-equivalence.mjs`: 0 mismatches on valid input); the "exports nothing imports" census was a
> grep over `src`, `e2e`, `__workers-tests__` because — finding K below — `pnpm knip` does not look at
> this package at all.

## Summary (5 lines)

1. **About −260 code lines and −70 test lines are on the table, none of it a design change.** The
   three biggest cuts are speculative machinery and restatement: four config parsers nothing names
   (S1, −60), the `@` lexer spelled as two hand-rolled quoted-string walkers plus a third in
   `matchingParen` when ONE literal regex does all three (S2, −40, measured), and the library's three
   signatures declared twice plus a re-export block that exists only to feed the second copy (S4, −30).
2. **The three connectors rhyme but do not share:** the per-connection "one prototype method per
   name" subclass is written twice with two hand-kept reserved-name lists (S3, −27), the non-2xx
   refusal five times in three wordings (S5, −15), and the no-await capnweb step walk is byte-identical
   to the relay's `#walkItxExpressionSteps` (S6, −11).
3. **The DO grew where it should not have:** three copies of the `FacetSpec` undefined-strip (S8), three
   `try { facets.abort } catch {}` blocks (S7), a binding redeclared under `Env` that `AppConfigEnv`
   already types (S9), and the facet door's one refusal living in built-ins.ts instead of at the door
   (S10). `#invokeFacet` is 172 lines; its memo/recovery block reads better as a named method (D2).
4. **Two predicates for one set:** the resolver asks the record (`Object.hasOwn`) and the reduce asks
   the list (`isBuiltInRoot`) whether a root is built in; the type-level assert already proves the sets
   equal, so the resolver's third parameter can go (S11). The BUILD-LOG's "knip clean" is vacuous for
   this package — `knip.ts` never lists it — and four exports have no importer (K).
5. **Nothing here is a rename of a surface name.** Nine items are NO-BRAINERs (under ten lines, tsc or
   an existing table row is the proof). Three items were considered and declined with the reason
   (D1–D3); two leftovers of the deleted e2e fixtures need a pin or a deletion (S22).

---

## Ranked table (LOC saved per unit of risk)

| id | file(s) | change | LOC saved | risk | no-brainer? |
|----|---------|--------|-----------|------|-------------|
| S1 | `src/app-config.ts:44-68`, `src/app-config.test.ts` | delete the four parsers no row names (`integer`, `boolean`, `url`, `json`) and their test rows; keep `string` | ≈60 (25 code + 35 test) | L | safe, not tiny |
| S2 | `src/context/expression.ts:40-118, 145-155` | ONE string-literal regex replaces `lexStringLiterals`, `printMarkers`' walker, `matchingParen`'s quote loop and `parse`'s inner substitution; `isItxExpressionHole` = `jsonEqual`; fold `MERGE_KEY` into the exported constant | ≈40 | L (measured) | no |
| S4 | `src/context/built-ins.ts:28-38, 187-202`, `src/library/index.ts:58-67` | `BuiltInScope extends LibraryRoots`; delete the three restated members, the seven-type import and the re-export block | ≈30 | L | no |
| S3 | `src/library/mcp.ts:110-137`, `src/library/openapi.ts:135-152` | ONE `subclassWithMethods(Base, names, call)`; reserved = `name in Base.prototype`, no hand lists | ≈27 | L | no |
| S19 | `src/context/itx-expression-rewriting.test.ts:477-547` | the door's refusals as one `{ match, target, throws }` table | ≈30 (test) | L | no |
| S5 | `src/library/{mcp,openapi,capnweb}.ts` (5 sites) | ONE `refuseUnlessOk(response, what)` in `library/index.ts` | ≈15 | M (3 regex re-pins) | no |
| S13 | `src/iterate-context.ts:215-230, 388-390` | merge `provide`'s `null` and expression branches (append first, then recall); inline `#appendInBackground` (one caller) | ≈12 | M / L | inline: YES |
| S6 | `src/library/capnweb.ts:62-72`, `src/context/rpc-stub-relay.ts:64-83` | ONE exported `walkStepsOnRpcStub` in `context/invoke-handle.ts` (inside the library's allow-list) | ≈11 | L | no |
| S8 | `src/iterate-context-durable-object.ts:511-515, 539-543`, `src/iterate-context.ts:335-339` | ONE `facetSpecOf(spec)` beside `FacetSpec` in worker-loader.ts | ≈10 | L | YES |
| S7 | `src/iterate-context-durable-object.ts:455-459, 587-591, 621-625` | ONE `#abortFacetIfRunning(name, reason)` | 8 | L | YES |
| S10 | `src/context/built-ins.ts:247-249, 353-361`, DO `:486` | `facets: deps.facets`; the non-string-name refusal moves to `#invokeFacet`'s first line | 8 | L | YES |
| S12 | `src/context/itx-expression-rewriting.ts:350-369`, DO `:674-677, 703-706` | `invoke(call, ...extraArgs)`; start `walkSteps` at the record so the root step is not special-cased | 8 | L | YES |
| S20 | `src/library/mcp.ts:197-225` | `readJsonRpcResponse`: pick the JSON texts, then ONE flatMap | 6 | L | YES |
| S11 | `src/context/itx-expression-rewriting.ts:220-233`, `src/stream/core-processor.ts:87-92`, test `:37,332,336` | drop `resolveItxExpression`'s `isBuiltInRoot` parameter; import the leaf's predicate | 5 | L | YES |
| S18 | `apps/dummy-petshop/src/capnweb.ts:28-31` | reuse `PetsContext` (rpc.ts:33) — the third copy of `{ owner; pets }` | 5 | L | YES |
| S21 | `src/library/openapi.ts:160-161, 202-206` | same-host as one boolean; `{ name, in, required }` without the undefined-strip | 5 | L | YES |
| S16 | `built-ins.ts:1-3, 23, 88-89`, `library/index.ts:5`, `app-config.ts:3, 7`, `rewriting.ts:261` | one WRONG docstring ("built-in first; no rule"), a stale root list, five history/date narrations | 4 | L | YES |
| S23 | `rewriting.ts:244-245, 280-281, 352-357`, `core-processor.ts:145` | `itxExpressionStepName(step)` in expression.ts for the four `Array.isArray(step) ? step[0] : step` sites | 4 | L | YES |
| S9 | `src/iterate-context-durable-object.ts:119-121` | delete `CF_VERSION_METADATA` from `Env` — `AppConfigEnv` (extended at `:112`) already types it | 3 | L | YES |
| K | `knip.ts`, `package.json:23`; `rewriting.ts:86-99, 103-105, 195` | add the package to the knip workspaces; un-export `PROXY_VERBS`, `isBuiltInsRooted`, `ItxExpressionPrefixMatch`, `applyItxExpressionRewriteRule` | 0 (4 keywords) | L | YES |
| S17 | `mcp.ts:51`, `openapi.ts:64`, `capnweb.ts:52, 118-121`, `rewriting.ts:163` | qualify `#client`, `#base`, `#dispose`, `#toSend/#received/#aborted`, `theOne` | 0 | L | YES |
| S22 | `src/worker.ts:79-81`, `src/sdk/index.ts:33`, `build-sdk.mjs` | the `/expression/<path>` suffix and the `newWorkersRpcResponse` export were added FOR fixtures deleted in arc 3b; no test reaches either now — pin each with one row or delete the suffix | 3 or +rows | M | no |

Declined (reasons at the end): D1 the parse→print→parse round trip in the door; D2 extracting
`#invokeFacet`'s memo/recovery and `#rewriteRuleList` (net 0, readability only); D3 `read` →
`readEvents` on the DO/stream (owner's stated internal exception; stream area).

---

## The items

**S1 — four parsers nothing names.** `src/app-config.ts:117-124` is the whole table: ONE row,
`environmentName`, parsed by `appConfigVarParsers.string`. Lines `:44-68` define `integer`, `boolean`,
`url` and `json` for rows that do not exist, and `src/app-config.test.ts` spends its parser-kind rows
(the eight `integer|boolean|url|json` hits between `:26-97`) proving them. The module's own header
states the rule that decides this: "a row nothing reads does not exist" — a parser no row names is the
same speculation one level down. **Edit:** delete `:44-68`; `appConfigVarParsers` becomes
`{ string }` (or drop the record and write `parse: (raw, name) => …` inline on the one row — then
`AppConfigVarParser<T>` at `:31` stays as the row's field type); delete the corresponding test rows and
the "every parser kind" sentence in the test header (`:1-2`). When a deployment needs an integer, the
parser arrives with its row and its consumer, which is exactly the inventory rule. ≈25 code + ≈35
test lines. Risk L: nothing imports these parsers (`appConfigVarParsers` has ONE importer, the test).

**S2 — ONE string-literal regex for the whole `@` codec (measured).** Today `expression.ts` walks
quoted strings three separate times with the same escape loop: `lexStringLiterals` (`:45-66`, 22
lines, used by `parse` at `:146-155` and by `printMarkers` at `:95-105`) and `matchingParen`'s inner
`for (const q = c; …)` at `:112-113`. All three are one regex:

```ts
const STRING_LITERAL = String.raw`"(?:[^"\\]|\\[\s\S])*"|'(?:[^'\\]|\\[\s\S])*'`;
const isStringLiteral = (m: string) => m[0] === '"' || m[0] === "'";
// the marker spellings FIRST in the print regex: at a `'` the literal alternative would otherwise swallow `'...@'`
const MARKERS_IN_ARGS = new RegExp(`${STRING_LITERAL}|\\.\\.\\.@|@`, "g");
const MARKERS_IN_PRINT = new RegExp(`\\{'@':true\\}|'\\.\\.\\.@':true|${STRING_LITERAL}`, "g");
const BRACKETS = new RegExp(`${STRING_LITERAL}|[()[\\]{}]`, "g");
```

`parse`'s inner (`:146-155`) becomes `raw.replace(MARKERS_IN_ARGS, (m) => { if (isStringLiteral(m))
return m; if (!options?.holes) fail("`@` (the caller's input) is legal only in a rewrite rule's
target"); return m === "@" ? '{"@":true}' : '"...@":true'; })`; `printMarkers` becomes
`text.replace(MARKERS_IN_PRINT, (m) => m === "{'@':true}" ? "@" : m === "'...@':true" ? "...@" : m)`
— the boundary argument in its docstring holds unchanged, because a user string that CONTAINS the
marker's printed form is emitted by JSON5 as a double-quoted literal and the literal alternative
consumes it whole (corpus case `"{'@':true}"`); `matchingParen` becomes an eight-line `BRACKETS.exec`
loop from `lastIndex = open` that skips literal matches and counts the rest. `isItxExpressionHole`
(`:69-77`, 10 lines) becomes `jsonEqual(value, { "@": true })` — `lib/patch.ts` is already the
codec's equality everywhere else (`keySortedForPrint`'s docstring names it). `MERGE_KEY` (`:38`) and
its alias `ITX_EXPRESSION_MERGE_KEY` (`:88-89`) are one constant: export the one name. **Measured:**
`scratchpad/lexer-equivalence.mjs` copies the three current walkers verbatim and runs 32 parse cases
(escaped quotes, `\\` before a closing quote, a multi-line literal, `'@'`, `"x@y"`, `[@, '@', {'...@':
1}]`, the reserved literal inside a string), 11 print cases (the hole, the merge entry, a two-key object
that must NOT print as `@`, `'@'` as a key, a nested hole) and 5 paren cases (`')'` and `'('` inside
literals, escaped quotes, nested braces): **0 mismatches on valid input.** The one divergence is an
unterminated literal (`'abc @`): both versions refuse it (JSON5 cannot parse it), but the wording moves
from "call args are not JSON5" to the `@` refusal — acceptable, or preserve it by trying `JSON5.parse`
first. ≈40 lines; the `@` arc's `expression.ts` goes from 162 to ≈120 code lines, i.e. the +121 lands
near the 60 the arc estimated. Risk L: the codec table (`itx-expression-rewriting.test.ts:403-441`) and
the round-trip rows are the gate.

**S4 — the library's three signatures declared twice.** `library/index.ts:33-46` declares
`LibraryRoots` with the three verbs and their docstrings; `built-ins.ts:187-202` restates the same three
with different docstrings; `index.ts:31-32` admits it ("`BuiltInScope` restates these three signatures").
The re-export block `index.ts:58-67` and the seven-type import `built-ins.ts:28-38` exist only so the
second copy can be spelled. **Edit:** `export interface BuiltInScope extends LibraryRoots { … }` with
the three members and the `// ── THE LIBRARY` comment (`:187-202`) replaced by two comment lines
pointing at `library/index.ts`; the import at `:28-38` becomes `import { buildLibrary, type LibraryItx,
type LibraryRoots } from "../library/index.ts"`; delete `index.ts:58-67`. `LibraryRoots` gains its one
importer (K lists it as importer-less today). ≈30 lines. Risk L: tsc; the `satisfies BuiltInScope` at
`built-ins.ts:387` still checks the spread.

**S3 — ONE prototype-method subclass for the connectors.** `mcp.ts:110-137` and
`openapi.ts:135-152` are the same 16 lines twice: a hand-kept `RESERVED_MEMBERS` set, the identifier
regex `/^[A-Za-z_$][\w$]*$/`, a `class extends Base {}` and a `defineProperty` loop. **Edit:** in
`library/index.ts`:

```ts
/** A per-connection subclass whose PROTOTYPE carries one method per name (prototype members are what
 *  Workers RPC and capnweb traverse, so `conn.echo({…})` works held across calls) — skipping names the
 *  base already declares and names that are not identifiers. */
export function subclassWithMethods<C extends new (...args: never[]) => object>(
  Base: C, names: string[], call: (self: InstanceType<C>, name: string, input: unknown) => unknown,
): C {
  const Subclass = class extends Base {};
  for (const name of names)
    if (!(name in Subclass.prototype) && /^[A-Za-z_$][\w$]*$/.test(name))
      Object.defineProperty(Subclass.prototype, name, { value(this: InstanceType<C>, input?: unknown) { return call(this, name, input); }, writable: true, configurable: true });
  return Subclass;
}
```

`connectToMcp` calls `subclassWithMethods(McpConnection, tools.map((t) => t.name), (self, name, args)
=> self.callTool(name, args as Record<string, unknown>))`; openapi likewise over `operationId`s. The
hand lists go: `name in Base.prototype` covers `constructor`, every declared method and everything
`RpcTarget` adds; the two lists' `invoke` and `applyRoot` entries were speculative — neither class
extends `InvokeHandle`, and `callOn` brand-checks with `instanceof`, never by name. (A genuine gap both
lists miss: a tool named `then` makes the connection a thenable, and both `walkSteps` and capnweb
await values — one more `name === "then"` exclusion if the owner wants it.) ≈27 lines. Risk L: the
reserved-name rows in `mcp.test.ts:134` and `openapi.test.ts:128` stay green.

**S19 — the door's refusals as a table.** `itx-expression-rewriting.test.ts:477-547` is five prose
`test(…)` blocks of `expect(() => rewriteRuleConfiguredEvent(m, t)).toThrow(re)` — fourteen refusals
and four acceptances written out. The file already has the shape at `:48-300` (`{ rules, call, becomes
}` / `{ rules, call, throws }`). **Edit:** one `doorRefusals: { match: ItxExpressionInput; target:
ItxExpressionInput | null; throws: RegExp }[]` (fourteen rows, each with the one-line reason as its
comment, the six proxy verbs as six rows) and one `doorAccepts: { match, target, payload }[]` (four
rows), each driven by a two-line `for … test(…)`. ≈30 test lines; nothing pinned changes. Risk L.

**S5 — ONE non-2xx refusal.** Five sites map a bad response to a thrown error with a body snippet, in
three wordings: `mcp.ts:185-190` (`MCP ${method}: ${status} ${text.slice(0, 300)}`),
`openapi.ts:124-129` (`${METHOD} ${path} (${op}) returned ${status}: ${snippet300}`),
`openapi.ts:163-164` (status only), `capnweb.ts:84-89` (`answered ${status} without a WebSocket:
${text.slice(0, 200)}`), `capnweb.ts:103-108` (`failed: ${status} ${statusText}`, body cancelled, no
snippet). **Edit:** in `library/index.ts`, `export async function refuseUnlessOk(response: Response,
what: string): Promise<Response>` — `if (response.ok) return response; const snippet = (await
response.text().catch(() => "")).slice(0, 300); throw new Error(`${what} returned ${response.status}${snippet
? `: ${snippet}` : ""}`)` — and the five sites become one call each with their `what` (`MCP
initialize`, `GET /v1/pets/1 (getPet)`, `connectToOpenApi: fetching ${specUrl}`, `connectToCapnweb:
${url}` — the 101 check stays a separate line since a 200 without a socket is also a refusal there).
≈15 lines. Risk M: three regexes re-pin — `mcp.test.ts:163` `/MCP initialize: 503 nope/` →
`/MCP initialize returned 503: nope/`, `openapi.test.ts:155` unchanged shape, `capnweb.test.ts:69`
`/failed: 502/` → `/returned 502/`.

**S13 — `provide`'s two data branches are one; an undo helper with one caller.** At
`iterate-context.ts:215-230` the `null` branch and the expression branch each build the event, append
it, recall this session's lend and hand back a `RewriteRuleHandle` whose undo expects the target it
wrote; they differ only in ORDER (null: append, then dispose; expression: dispose, then append) and in
the expected target (`null` vs the printed string). The order that is safe for BOTH is append-first:
the DO's `#unsetWhatNamesRpcStub` (DO `:170-193`, fired by the pager close the dispose causes) removes
only rows whose target still RESOLVES to the stub's key, so once the row has been rewritten to the new
target — a mask or an expression — the un-set finds nothing to remove and cannot delete a fresh mask.
(Dispose-first on the null branch would race the removal against the mask and could delete it; today's
null branch already avoids that.) **Edit:**

```ts
if (target === null || typeof target === "string" || Array.isArray(target)) {
  const event = rewriteRuleConfiguredEvent(matchString, target);
  await this.#append(event);
  // the row no longer names whatever THIS session lent under the match — recall it AFTER the append,
  // so the DO's un-set on the pager close finds nothing that still names the stub
  this.#sessionTeardown.dispose(sessionTeardownKey);
  const expectedTarget = (event.payload as { target: string | null }).target;
  return new RewriteRuleHandle(() => this.#removeRuleInBackground(matchString, expectedTarget));
}
```

The one behavioral edge: an expression `provide` whose append is REFUSED (paused stream) today recalls
the lend before throwing; after, it throws with the lend intact — no test pins the old shape
(`review-bugs-edge-side.e2e.test.ts:69-76` pins the STUB branch, which is untouched). Separately,
`#appendInBackground` (`:388-390`) has exactly one caller (`:307`): inline it as
`this.#waitUntil(this.#append(subscriptionConfiguredEvent({ name, target: null })).catch(() =>
undefined))` and move its two-line docstring onto that call. ≈12 lines (8 + 4). Risk M for the merge
(the ordering argument above; `rewrite-rules-builtins-root.e2e` and `rpc-stubs-lend-recall-and-offline.e2e`
are the gate), L for the inline — the inline alone is a NO-BRAINER.

**S6 — the no-await capnweb walk exists twice.** `capnweb.ts:62-72` (`walkCapnwebStub`) and
`rpc-stub-relay.ts:64-83` (`LentRpcStub.#walkItxExpressionSteps`) are the same eleven lines: property
step → `value[step]`, call step → `value[method](...args)`, anonymous step → `value(...args)`, no await
inside the loop because every step on a capnweb stub is a pipelined path. **Edit:** `export function
walkStepsOnRpcStub(stub: unknown, steps: ItxExpression): unknown` in `context/invoke-handle.ts` (the
one `context/` module the library may import at runtime — `boundary.test.ts:13-17`), carrying the
relay's comment about `.apply` being a pipelined remote path; both sites call it, the relay awaiting
the result as today. ≈11 lines. Risk L: `capnweb.test.ts` (a real batch round trip) and
`rpc-stub-relay.test.ts` cover both callers.

**S8 — three copies of the `FacetSpec` strip.** DO `:511-515` (`storedSpec`), DO `:539-543`
(`recovered`, with a cast at `:540` because `facetSpecFromHostingTarget` returns `source: unknown`) and
`iterate-context.ts:335-339` (`enableProcessor`'s target) each spell `{ source, ...(cacheKey !==
undefined && { cacheKey }), className }`. **Edit:** beside `FacetSpec` in `worker-loader.ts:60`:
`export const facetSpecOf = ({ source, cacheKey, className }: FacetSpec): FacetSpec => ({ source,
...(cacheKey !== undefined && { cacheKey }), className });` and the three sites become one call each
(the DO's second site as `facetSpecOf(spec as FacetSpec)`, keeping today's one cast). ≈10 lines.
Risk L: tsc; the memo compare at DO `:516` is by `JSON.stringify` and unchanged. (Stricter option the
owner may prefer: drop the strip entirely — `JSON.stringify`, `JSON5.stringify` and the kv compare all
ignore `undefined` — but that changes what a `kv.get` of the memo returns, so it is a separate call.)

**S7 — three `abort` guards.** DO `:455-459`, `:587-591`, `:621-625` are `try {
this.ctx.facets.abort(name, reason) } catch { /* not running */ }`. **Edit:** `#abortFacetIfRunning(
name: string, reason: string): void { try { this.ctx.facets.abort(name, reason); } catch { /* not
running — already quiesced */ } }` and three one-line calls. 8 lines. NO-BRAINER.

**S10 — the facet door's refusal belongs at the door.** `built-ins.ts:353-361` wraps `deps.facets.get`
in eight lines whose only content is `if (typeof name !== "string") throw …` — the record's every other
view is a pass-through (`rpcStubs: deps.rpcStubs`, `subscriptions: deps.subscriptions`). The DO's
`#invokeFacet` (`:486`) already owns the door's first refusal (`facet: name a method`). **Edit:**
`facets: deps.facets,` in the record; `facets: BuiltInScope["facets"]` in `BuildBuiltInsDeps`
(`:247-249`, like its neighbours at `:240-246`); the `typeof name !== "string"` refusal, with its
message, as the first line of `#invokeFacet`. 8 lines. NO-BRAINER.

**S12 — the resolver's `invoke` special-cases the root step that `walkSteps` already handles.**
`rewriting.ts:352-368`: after resolving, it reads `rewritten[2]`, checks it, reads the record entry by
hand, calls it by hand if it is a call step, then hands the REST to `walkSteps`. `walkSteps`
(`dispatch.ts:44-84`) does exactly that for a property or call step at index 0 when started at the
record. The `extraArgs?: unknown[]` optional array is folded by the DO at `:676` (`args.length > 0 ?
args : undefined`) and re-wrapped by the fetch lane at `:705` (`[new Request(…)]`). **Edit:**

```ts
async invoke(call: ItxExpressionInput, ...extraArgs: unknown[]): Promise<unknown> {
  const rewritten = this.resolve(call).at(-1)!;
  const rootName = itxExpressionStepName(rewritten[2]);   // S23
  if (rootName === undefined) throw new Error(`"itx.builtins" names the reserved root — name a built-in under it (${keys})`);
  if (!Object.hasOwn(this.#builtIns, rootName)) throw codedError("NO_ITX_EXPRESSION_MATCH", `no built-in ${JSON.stringify(rootName)} under itx.builtins (${keys})`);
  const { value, receiver } = await walkSteps({ value: this.#builtIns, receiver: undefined }, rewritten.slice(2));
  return extraArgs.length ? await callOn(value, receiver, extraArgs) : value;
}
```

Both refusals keep their words; the DO's `invoke` passes `...args`, the fetch lane passes the Request
bare. The one observable change: a root-level CALL step is applied with the record as receiver instead
of `undefined` — every root is an arrow or a closure (`built-ins.ts:309-386`), so nothing reads `this`.
8 lines. Risk L: `dispatch.test.ts` rows and the LAW row (`rewriting.test.ts:691`) are the gate.

**S20 — `readJsonRpcResponse`'s two branches end the same way.** `mcp.ts:200-218` builds
`candidates` with an SSE branch and a JSON branch that both finish in `Array.isArray(parsed) ? parsed
: [parsed]`. **Edit:** `const texts = contentType.includes("text/event-stream") ? text.split(/\r?\n\r?\n/).map(dataLinesOf).filter(Boolean) : [text]; const candidates = texts.flatMap((t) => { const parsed = JSON.parse(t) as JsonRpcResponse | JsonRpcResponse[]; return Array.isArray(parsed) ? parsed : [parsed]; });` with `dataLinesOf` the existing four-line block→`data:` join. 6 lines. NO-BRAINER; `mcp.test.ts`'s SSE row covers it.

**S11 — one predicate for "is this root built in".** `resolveItxExpression` (`rewriting.ts:220-224`)
takes `isBuiltInRoot: (root: string) => boolean`; the DO's resolver passes `Object.hasOwn(this.#builtIns,
root)` (`:340-342`) while the reduce passes the leaf's `isBuiltInRoot` (`core-processor.ts:87-92`) and
every test row passes the leaf's too (`rewriting.test.ts:37, 332, 336`). `built-ins.ts:205-213` proves
at the type level that the record's keys and the leaf's list are one set, so the runtime has two
spellings of one truth. **Edit:** `import { isBuiltInRoot } from "./built-in-roots.ts"` in
`rewriting.ts` (a leaf — no cycle; the header of `built-in-roots.ts` was written for exactly this),
delete the parameter and the three call-site arguments; `ItxExpressionResolver.resolve` becomes
`resolveItxExpression(this.#rewriteRules, toItxExpression(call))`. `#builtIns` stays for `invoke`'s
gate. 5 lines. NO-BRAINER.

**S18 — the pet shop's third `{ owner; pets }`.** `apps/dummy-petshop/src/capnweb.ts:28-31` coins
`CapnwebApiContext` while `rpc.ts:33` (`PetsContext`) and `mcp.ts:28` (`McpToolContext`) already
declare the identical shape and the docstring says so ("the same pair the MCP tools and the oRPC
procedures receive"). **Edit:** `import type { PetsContext } from "./rpc.ts"` and use it in the
constructor and `handleCapnwebRequest`; delete the interface. 5 lines. NO-BRAINER. (The `createPet`
trim/non-empty check at `:58-60` duplicates the zod `min(1)` the other two doors use — accepted, capnweb
has no schema layer.)

**S21 — two small over-copies in openapi.ts.** `:160-161` computes `apiHost` from `baseUrl` or the
spec URL and then compares the spec URL's host to it — when there is no `baseUrl` the comparison is
`x === x`. **Edit:** `const sameHost = !options.baseUrl || new URL(options.baseUrl).host === new
URL(specUrl).host; const headers = sameHost ? (options.headers ?? {}) : {};`. `:202-206` copies each
parameter field by field to strip an `undefined` `required`: `parameters: [...pathParameters,
...own].map(({ name, in: location, required }) => ({ name, in: location, required }))` — `operations()`
is compared with `toEqual` in the tests, which treats an `undefined` property as absent. 5 lines.
NO-BRAINER.

**S16 — one wrong docstring, one stale list, five narrations.** `built-ins.ts:88-89` says the roots are
resolved "DIRECTLY (itx-expression-rewriting.ts, built-in first; no rule)" — that is the PREVIOUS
resolver; rules resolve first since 9543f5ee7 (rule 5). `built-ins.ts:1-3` enumerates fourteen roots
and omits the three library verbs while claiming "the one list is context/built-in-roots.ts" — say only
that. History narration that names dates instead of the code: `built-ins.ts:23` "(BUILD-LOG
2026-09-02)", `library/index.ts:5` "(the owner's litmus test, 2026-09-04: …)", `app-config.ts:3`
"BUILD-LOG 2026-09-03 W3(b)" and `:7` "(the inventory of 2026-09-04)", `rewriting.ts:261` "canonicalized
through the codec now". **Edit:** rewrite `:88-89` as "the physical-layer roots — `itx.builtins.<root>`
directly, `itx.<root>` through the implicit platform row unless a rule says otherwise (rule 5)"; the
rest lose their dates and "now". 4 lines. NO-BRAINER.

**S23 — `itxExpressionStepName`.** `Array.isArray(step) ? step[0] : step` is spelled at
`rewriting.ts:244-245`, `:280-281`, `:352-357` and `core-processor.ts:145`. **Edit:** `export const
itxExpressionStepName = (step: ItxExpressionStep | undefined): string | undefined => Array.isArray(step)
? step[0] : step;` in `expression.ts` beside `ItxExpressionStep`, with a one-line docstring; four sites
become one line each. 4 lines. NO-BRAINER (S12 uses it).

**S9 — a binding typed twice.** `app-config.ts:150` puts `CF_VERSION_METADATA?: { id: string }` on
`AppConfigEnv`; the DO's `Env extends AppConfigEnv` (`:112`) and redeclares it at `:119-121` with a
docstring that repeats `app-config.ts:13-16`. **Edit:** delete `:119-121`. 3 lines. NO-BRAINER.

**K — knip does not see this package; four exports have no importer.** `package.json:23` runs knip
with an explicit `--workspace` list and `knip.ts` configures only those; `packages/v3/project-worker`
is in neither, and `npx knip --workspace packages/v3/project-worker` answers "Workspace directory not
found". Every "knip clean" in today's BUILD-LOG entries is therefore vacuous for this package. A grep
census over `src`, `e2e`, `__workers-tests__` finds these exports with no importer outside their own
file: `PROXY_VERBS` (`rewriting.ts:87`), `isBuiltInsRooted` (`:97`), `ItxExpressionPrefixMatch`
(`:105`), `applyItxExpressionRewriteRule` (`:196`), `LibraryRoots` (`index.ts:34`, resolved by S4).
`McpTool`, `McpServerInfo` and `OpenApiOperation` are exported types with no importer but appear in
public method signatures — keep. **Edit:** drop the four `export` keywords; add a `packages/v3/project-worker`
entry to `knip.ts` (with `wrangler.test.jsonc`, `build-sdk.mjs` and the generated SDK as entries/ignores
as the sibling workspaces do) so the next "knip clean" means something. 0 lines. NO-BRAINER for the
keywords; the workspace entry is a root-config change the coordinator should own.

**S17 — names that stop short.** Private fields named by their type rather than their role:
`McpConnection.#client` (`mcp.ts:51`) → `#jsonRpcClient`; `OpenApiConnection.#base` (`openapi.ts:64`)
→ `#requestBaseUrl`; `CapnwebConnection.#dispose` (`capnweb.ts:52`) → `#closeSession`;
`EgressBatchTransport.#toSend / #received / #aborted` (`:118-121`) → `#messagesToSend /
#answersReceived / #abortReason`; the local class `Connection` in both `with*Methods` (folded by S3);
`theOne(what)` (`rewriting.ts:163`) → `theOneUnpinnedArg`. The lexer-local single letters (`q`, `j`,
`s`, `m`) go with S2. 0 lines, tsc. NO-BRAINER.

**S22 — two platform features whose only consumer was deleted.** Arc three added the
`/expression/<path>` suffix (`worker.ts:79-81`) and the SDK's `newWorkersRpcResponse` export plus the
`conditions: ["workerd"]` build (`sdk/index.ts:33`, `build-sdk.mjs`) for three loaded-worker fixtures;
arc 3b deleted the fixtures and kept both "as platform features". Today no test reaches either: the
suffix's only mention outside `worker.ts` is a URL string in `openapi.test.ts:160` against a FAKE itx,
and `newWorkersRpcResponse` is imported by nothing under `src/`/`e2e` except the bundle itself. The
doctrine is "prove or delete": either one workers-lane row for the suffix (a stub fetch through
`/expression/x/y?context=&itx=` asserting the path arrives) and one for a loaded worker serving
`newWorkersRpcResponse`, or delete the suffix (3 lines) and note the export as untested. Risk M —
reverting the `workerd` build condition is NOT proposed (it changed which `RpcTarget` the bundle
carries; that needs its own measurement).

---

## The DO's growth, in one paragraph

`iterate-context-durable-object.ts` is 790 lines; `#invokeFacet` alone is 172 (`:481-652`). The
built-ins wiring block (`:318-370`) is the DO handing its seams to the record and belongs where it is;
the two effects after commit (`#appendAndRunCommittedEffects`, `#deleteFacetsWhoseHostingSubscriptionWasRemoved`,
`:242-280`) are the DO's own and read well. Two blocks would read better elsewhere at net 0 lines:
the startup memo + M1 recovery (`:505-550`, 46 lines) as `#facetStartupMemoFor(name, spec):
FacetSpec` so `#invokeFacet` is memo → load → call; and `#rewriteRuleList` (`:298-315`) as a pure
`effectiveRewriteRuleList(rules)` in `itx-expression-rewriting.ts` — the header at `:34-35` already
names `list()` as one of the two readers that spell the platform rows, and a pure function gets a
table row beside `resolve`'s. Both are readability, not reduction (D2).

## Considered and declined

- **D1 — the door's `parse(print(toItxExpression(target, { holes: true })), { holes: true })`
  (`rewriting.ts:290-293`).** It looks like a wasted round trip, but for the ARRAY half it is the
  only validation (reserved names, an anonymous call at the root, an argless pinned step) — the
  string half was already parsed. Keep; the comment at `:261-262` could say so in one line.
- **D2 — extracting `#invokeFacet`'s memo/recovery and `#rewriteRuleList`.** Net 0 lines; listed
  above under the DO's growth for the coordinator, not ranked.
- **D3 — `read` → `readEvents` on the DO verb, `ReachableContext.read` and `Stream.read`.** One verb
  in two spellings across layers is a real leftover of today's rename, but the BUILD-LOG states the
  internal names were kept on purpose and `Stream.read` is in the memory-budget arc's file. Noted, not
  proposed.

## Duplication with the memory-budget arc's areas (noted, not proposed)

- `hostedFacet: { name: string; className: string; cacheKey?: string }` is spelled three times:
  `core-processor.ts:108`, `:161` and `built-ins.ts:66`. One exported type in core-processor.ts.
- `facetSpecFromHostingTarget` (`core-processor.ts:59`) returns `source: unknown` where every caller
  wants `FacetSpec["source"]` (the DO casts at `:540`); typing its return as `FacetSpec | undefined`
  removes the cast and lets S8's helper take it directly.
- `resolveThroughState` (`core-processor.ts:87-92`) is the reduce-side twin of
  `ItxExpressionResolver.resolve`; S11 makes them the same call with the same two arguments.

## Method and gates

Read: the ten commits' diff over `packages/v3/project-worker` and `apps/dummy-petshop`; the
2026-09-04 BUILD-LOG entries; every changed non-test file under `src/context`, `src/library`, the DO,
the edge proxy, `app-config.ts`, `worker.ts`, `sdk/index.ts`, the pet shop's `capnweb.ts` and its
worker hunk; today's unit, workers and e2e test hunks. Run: `pnpm knip` at the root (does not cover
this package — K), `npx knip --workspace packages/v3/project-worker` (refused: not a workspace), a
grep census of every new export's importers, and `scratchpad/lexer-equivalence.mjs` for S2. Not run:
the package's own test suites (other agents are editing the tree; every proposed edit names its gate).
