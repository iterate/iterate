# Bug hunt, round 2 — the edge, the codec and the client side (2026-09-04)

Area: today's ten commits (`bccbaec0a..HEAD`) as seen from a caller — `src/context/expression.ts`
(the `@` lexer both directions), `src/context/itx-expression-rewriting.ts` (rule 7, the door, the
resolver's live-args door), `src/context/{dotted-path-proxy,invoke-handle,dispatch}.ts` with capnweb's
`RpcPromise`/`RpcStub` registered as pipelined brands, `src/iterate-context.ts` (`provide` ×3,
`subscribe` after the attach fold, `invoke(call, ...args)`), `src/itx-entrypoint.ts`, `src/worker.ts`
(the `/expression/<path>` lane, `/version`), `src/session.ts`, `e2e/support/client.ts`, the connector
clients in `src/library/*.ts`, and `apps/dummy-petshop`'s `/capnweb` door. Branch
`wip/kernel-wayfinder-2026-07-30`; nothing under `src/` was edited — one new file, this report.

Method: every candidate below carries the file:line, the concrete input, the wrong output and how it
was observed — a node script over the pure modules (the codec, the resolver, the two HTTP
connectors with a fake `itx`) in the session scratchpad, or a precise reading where the state lives
in the DO. The codec was fuzzed: 40,000 random structural expressions (strings with quotes,
backslashes, `@`, `...@`, `{'@':true}` text, U+2028, emoji; nested objects/arrays; the two marker
literals) through `print → parse(holes) → print` — **zero round-trip or print-stability failures**.
The lexer is sound. What is wrong is around it: where the array half enters without the check the
string half gets, and where live args skip the rules. Baseline: the 158 unit tests in
`expression`, `itx-expression-rewriting`, `dispatch` and `src/library` are green on this tree.

## Summary

Two MAJOR, the rest MINOR, most with a fix under ten lines.

1. **The live-args door resolves the call WITHOUT its live args.** `invoke("itx.fable", inputs)` on
   the dream rule runs the real `ai.run('@cf/…')` with NO inputs (rule 7's "drop" branch, a side
   effect) and then throws `NOT_A_METHOD`; `invoke("itx.ai.run", "gpt-5", x)` walks past the pinned
   rule at `itx.ai.run('gpt-5')` to the real binding; `invoke("itx.kv.get", "secret")` walks past a
   MASK at `itx.kv.get('secret')`. The fetch lane's Request rides this same door.
2. **`subscribe`'s expression handle is the stale undo the rules got fixed for today.** Its dispose
   appends `{ name, target: null }` unconditionally; a later same-name subscribe (documented: "same
   name REPLACES") loses its row when the old handle is disposed or its session ends — and when
   the replacement HOSTED a facet, the DO deletes the facet and its storage.
3. `connectToMcp` hangs forever on a server that keeps the POST's SSE stream open (no timeout,
   `response.text()` waits for EOF).
4. `connectToOpenApi` behind the fetch lane: a relative `servers[0].url` drops `?context=&itx=`; every
   operation then hits the worker's banner and returns it as the answer, 200, silently.
5. `rewriteRules.list()` lists the platform rows under a bare `itx` override that shadows all of them.
6. The reserved literal `{ "@": true }` leaks through the ARRAY half: a subscription target carrying
   it is stored, then silently dropped by the reduce; a call carrying it breaks the resolve/invoke law.
7. The ARRAY half of a match skips the door (`["itx", "builtins.kv"]`, `["itx", "cd.x"]`,
   `["itx", "a b"]`), and a stored builtins-rooted match makes the DO's last-pager-close un-set THROW
   mid-loop.
8. Non-Latin1 in an expression makes both fetch-lane doors throw a ByteString TypeError (a 500, not a 400).
9. `e2e/support/client.ts` `until()` swallows the cause of a 20 s timeout; `readHead` reads one budgeted page.
10. The `@` lexer and `matchingParen` do not know JSON5 comments.
11. `rewriteRules.get(match)` compares a raw string against canonical keys.
12. The `/expression` lane re-enters itself through egress (pre-existing, unbounded recursion).

Checked and clean (no finding): the pet shop's `/capnweb` door (auth before capnweb on both the
POST and the upgrade, the 401 shape, capnweb's own 400 on a bare GET); the pager attach fold
(`provide`/`subscribe` refusal releases the dup and nothing is lent; the page-in-flight survives a
replace); the session-teardown keys across contexts and projects; the `provide(match, null)` and
`provide(match, expression)` undo (compare-and-set on the row's target, removal spelling, never a
mask); `#unsetWhatNamesRpcStub` is read-then-append in ONE synchronous turn (no TOCTOU against a
racing expression provide); capnweb's `RpcStub` is not thenable (its proxy answers `then` only for
`RpcPromise`), so registering it as a pipelined brand changes nothing an await would have; the
`/version` composition.

## Confirmed bugs, by severity

### 1. `invoke(call, ...args)` applies the live args AFTER the rules ran on an arg-less call — templates drop them, pinned rules and masks are skipped (MAJOR)

**Where** `src/context/itx-expression-rewriting.ts:350-368` (`ItxExpressionResolver.invoke`: `resolve(call)`
first, `callOn(value, receiver, extraArgs)` last); the two public doors that feed it —
`src/iterate-context.ts:173-193` and `src/iterate-context-durable-object.ts:674-677` — and the fetch lane
`src/iterate-context-durable-object.ts:703-706`.

**Mechanism** The chain is computed for `call` as written. For `invoke("itx.fable", inputs)` the call is
the PROPERTY `itx.fable`; rule 7's fill sees `unpinnedArgs === undefined` and takes the documented
"a property access on the match drops it" branch (`:190-192`), so the rewritten call is
`itx.builtins.ai.run('@cf/x')` — a CALL with one arg — which `walkSteps` runs, and only then are the
live args applied to its RESULT, which is not callable. The inference fires with no inputs before the
error. The same shape bypasses every rule that needs the args to match: a pinned-arg row
(`itx.ai.run('gpt-5') ⇒ …`) never matches the property `itx.ai.run`, so the implicit platform row wins
and the real binding is called with `('gpt-5', x)`; a pinned MASK (`itx.kv.get('secret') ⇒ null`,
default-deny) is walked around the same way.

**Proof** (node, the pure resolver over a fake `builtIns` record, scratchpad `probe-live-args.mts`):

```
A1  itx.fable({prompt:'hi'})                       calls ai.run(["@cf/x",{"prompt":"hi"}])   ok
A2  invoke('itx.fable', {prompt:'hi'})             calls ai.run(["@cf/x"])                   !! target is not callable but 1 arg(s) were passed
B1  itx.ai.run('gpt-5', {q:1})   (pinned → stub)   calls rpcStubs.get(…), stub([{"q":1}])    ok
B2  invoke('itx.ai.run', 'gpt-5', {q:1})           calls ai.run(["gpt-5",{"q":1}])           the pinned rule never saw it
C1  itx.kv.get('secret')          (masked)         calls []                                  refused, as documented
C2  invoke('itx.kv.get', 'secret')                 calls kv.get(["secret"])                  the mask never saw it
```

Both documented sentences are true on their own — `invoke("itx.kv.get", "k") ≡ itx.kv.get("k")` (as-built
§3) and "a property access on the match drops it" (rule 7) — and contradict each other exactly here.

**Suggested fix** Fold the live args INTO the call before resolving, when the call's last step is a
name: in `ItxExpressionResolver.invoke`, `const folded = extraArgs && typeof call.at(-1) === "string" ?
[...call.slice(0, -1), [call.at(-1), ...extraArgs]] : call;` then resolve `folded` and apply
`extraArgs` only in the other case (a call-final expression, where they apply to the result as today).
~4 LOC. The fetch lane keeps its shape: `itx.site.fetch` + `[request]` folds to `itx.site.fetch(request)`,
rule 4 carries `["fetch", request]` after the target, and `invokeRpcStub`'s terminal-fetch branch /
`#invokeFacet`'s `first[0] === "fetch"` see the identical step; a Request only ever meets `jsonEqual`
when a rule pins an arg at that position. NO-BRAINER, with one deliberate consequence: masks and pinned
rows now apply to the live-args door too, which is what "default-deny" means.

**Failing test** `src/context/itx-expression-rewriting.test.ts`, section "the resolver" —
`test("invoke(call, ...args) resolves the call WITH its live args: a template fills, a pinned row matches, a mask refuses")`:
`await expect(resolver.invoke("itx.fable", { prompt: "hi" })).resolves.toEqual(await resolver.invoke("itx.fable({ prompt: 'hi' })"))`,
`expect(await resolver.invoke("itx.ai.run", "gpt-5", x)).toBe("stubbed")`,
`await expect(resolver.invoke("itx.kv.get", "secret")).rejects.toMatchObject({ code: "NO_ITX_EXPRESSION_MATCH" })`.
End to end: `e2e/rewrite-rules-builtins-root.e2e.test.ts`, the LAW test — add
`expect(await itx.invoke("itx.fable", { prompt: "hi" })).toEqual(await itx.fable({ prompt: "hi" }))` against the fake `itx.ai`.

**Blast radius** Every caller of the live-args door: `invoke(call, ...args)` on the proxy and the DO,
and the fetch lane whenever the addressed match carries a pinned arg or a mask.

---

### 2. A `subscribe` expression handle un-sets whatever row bears the name now — and takes a hosted facet's storage with it (MAJOR)

**Where** `src/iterate-context.ts:304-308` (the undo: `#appendInBackground(subscriptionConfiguredEvent({ name, target: null }))`,
unconditional). Compare the rules' undo written today, `#removeRuleInBackground` (`:371-384`): it reads
the row and appends the removal ONLY when the target is still the one this handle wrote. The DO's
removal effect is `src/iterate-context-durable-object.ts:260-280`
(`#deleteFacetsWhoseHostingSubscriptionWasRemoved` → `#deleteFacet`, storage included).

**Mechanism** "Same name REPLACES" (subscriptions.ts header, `subscribe`'s doc). Session A:
`subscribe({ name: "audit", target: exprA })`, holding a `SubscriptionHandle`. Session B:
`subscribe({ name: "audit", target: "itx.facets.get('audit', spec).processEventBatch" })` — the row is
B's now, `hostedFacet` set, the facet materializes and reduces. A's tab closes (capnweb disposes every
exported handle at session end) → A's undo appends `{ name: "audit", target: null }` → the reduce
deletes B's row → `#deleteFacetsWhoseHostingSubscriptionWasRemoved` finds no other host →
`ctx.facets.delete("audit")` + the kv memo. B's processor and its storage are gone; B is never told.
The same holds inside one session: `h1 = subscribe({name})`, `h2 = subscribe({name})`, `h1[Symbol.dispose]()`
deletes h2's row. The prior review's finding 1 was this bug class on rules; the rules got the
compare-and-set today, the subscriptions did not.

**Proof** By reading: the undo has no read; the DO's removal effect keys on the name alone.

**Suggested fix** Mirror `#removeRuleInBackground`: the append already returns the committed event —
`const [committed] = await this.#append(...)` (a `StreamEvent[]`) — keep `committed.offset`, and let the
undo `invoke(["itx","builtins","subscriptions",["get", name]])` and append `null` only when
`row?.configuredAtOffset === committed.offset`. ~8 LOC. NO-BRAINER.

**Failing test** `e2e/review-round2-bugs-edge-side.e2e.test.ts` —
`test("subscribe: a stale expression handle's dispose leaves a later same-name row (and the facet it hosts) alone")`:
two sessions on one ctx; A subscribes `{ name: "p", target: "itx.kv.get" }`; B subscribes `{ name: "p", target: "itx.facets.get('p', { source, className }).processEventBatch" }`;
append one event and `until` the facet's snapshot reflects it; dispose A's handle; `await sleep(800)`;
`expect((await subscriptions(observer)).map(r => r.name)).toEqual(["p"])` and
`expect(await observer.invoke("itx.facets.get('p').snapshot()")).toBeDefined()` (today: `[]`, then `NO_FACET`).

**Blast radius** Any named subscription re-configured from another session (a redeploy of the
subscriber, a reconnect that re-subscribes under the same name) while an older session still holds
the handle — and every processor hosted through `subscribe` rather than `enableProcessor`.

---

### 3. `connectToMcp` hangs forever on an SSE answer the server keeps open (MAJOR — a hang, with a caveat)

**Where** `src/library/mcp.ts:197-224` (`readJsonRpcResponse`: `const text = await response.text()` at `:199`,
then split into events); no deadline anywhere in `mcp.ts`.

**Mechanism** MCP Streamable HTTP lets a server answer a POST with `text/event-stream`, send
notifications and requests BEFORE the JSON-RPC response, and after it "SHOULD close the SSE stream" —
SHOULD, not MUST; a server that keeps the stream for later server→client traffic is conformant. The
client reads the WHOLE body before looking for its id, so it waits for EOF that never comes:
`connectToMcp` never resolves, and the caller's `invoke` (and its DO facet-call watchdog, if any) is the
only backstop. A server-initiated request on that stream (elicitation, sampling) is likewise never
answered, so a server waiting for it hangs the same way.

**Proof** Scratchpad `probe-library.mts`: a fake `itx.fetch` answering `initialize` as one `data:` event on
a `ReadableStream` whose controller is never closed —
`MCP over an SSE stream the server keeps open: HUNG after 3s (no timeout, response.text() never resolves)`.
Caveat, honestly: the pet shop answers plain JSON, and the reference SDK servers close the stream after
the response, so the deployed proof never met this.

**Suggested fix** Read the SSE body incrementally (`response.body.getReader()` + a `TextDecoder`, split
on blank lines as they arrive), resolve at the first `data:` event whose `id` matches, then
`reader.cancel()`; keep the JSON branch as is. ~20 LOC. Optionally a per-request deadline via
`signal: AbortSignal.timeout(ms)` on the `Request` (in-isolate, it reaches `itx.fetch` intact) — 2 LOC.

**Failing test** `src/library/mcp.test.ts` —
`test("an SSE answer that stays open after the response still connects: the response is read as it arrives")`:
the fake above; `await expect(Promise.race([connectToMcp(itx, url), sleep(2000).then(() => { throw new Error("hung") })])).resolves.toBeDefined()`.

**Blast radius** Any third-party MCP server that keeps the POST stream open or speaks server→client requests.

---

### 4. OpenAPI behind the fetch lane: a relative `servers[0].url` drops the lane's query and every call returns the worker's banner (MINOR)

**Where** `src/library/openapi.ts:170-182` (`requestBase`): `if (serverUrl) return new URL(serverUrl, specUrl)`
at `:177` — the QUERY-keeping branch is only the no-servers fallback (`:179-181`), which the header comment
advertises as "so a service served over the fetch lane works like any other".

**Mechanism** `new URL("/api", "https://w/expression/openapi.json?context=X&itx=itx.svc.fetch")` is
`https://w/api` — `context` and `itx` are gone. Every operation then hits `https://w/api/pets`, which is
the worker's default handler: `200 text/plain "project-worker — /api (capnweb), /expression, /demo, /version"`.
`call()` sees `response.ok`, a non-JSON content type, and RETURNS THE BANNER as the operation's result.
A relative `servers` entry (`/api`, `/v1`) is the common spelling in generated documents.

**Proof** `probe-library.mts`: requests `GET https://worker/expression/openapi.json?context=…&itx=…` then
`GET https://worker/api/pets`; `listPets => "project-worker — /api (capnweb), /expression, /demo, /version\n"`.

**Suggested fix** In `requestBase`, when `serverUrl` is relative (`!/^[a-z][a-z0-9+.-]*:/i.test(serverUrl)`)
and `specUrl` has a query, copy it: `base.search = new URL(specUrl).search`. 3 LOC. NO-BRAINER.

**Failing test** `src/library/openapi.test.ts` —
`test("a relative servers[0].url resolved against a fetch-lane spec URL keeps ?context=&itx=")`: the fake
above; `expect(seen[1]).toBe("GET https://worker/expression/api/pets?context=prj_x&itx=itx.svc.fetch")`.

---

### 5. `rewriteRules.list()` shows platform rows a bare `itx` override has shadowed (MINOR)

**Where** `src/iterate-context-durable-object.ts:298-315` (`#rewriteRuleList`): `reset` is the set of
context matches, and a platform row is listed unless `reset.has("itx.<root>")` exactly.

**Mechanism** Rule 3: a bare `itx` row matches EVERY call, and rules resolve FIRST, so under
`provide("itx", stub)` no short-named call ever reaches an implicit platform row (`resolveItxExpression`
never gets to `:244-251` while a row matches). `list()` still says `{ match: "itx.kv", target: "itx.builtins.kv", origin: "platform" }`
beside the `itx` row — an effective-table listing that contradicts `resolve`.

**Proof** Pure resolver with rules `[{ match: ["itx"], target: itx.builtins.rpcStubs.get('x') }]`:
`resolve("itx.kv.get('a')")` → `itx.builtins.rpcStubs.get('x').kv.get('a')` (scratchpad `probe-codec.ts` #30);
`#rewriteRuleList` by reading lists `itx.kv ⇒ itx.builtins.kv (platform)` for the same context.

**Suggested fix** `const platformRows = reset.has("itx") ? [] : BUILT_IN_ROOTS.filter(...)`. 1 LOC. NO-BRAINER.

**Failing test** `e2e/rewrite-rules-builtins-root.e2e.test.ts`, the whole-context-override test — add
`expect((await root.cd("/x").builtins.rewriteRules.list()).filter(r => r.origin === "platform")).toEqual([])`.

---

### 6. The reserved literal leaks through the ARRAY half: a subscription target carrying `{ "@": true }` is stored, then silently dropped; a call carrying it breaks the resolve/invoke law (MINOR)

**Where** `src/context/expression.ts:198-207` (`print` spells the markers for EVERY expression — there is no
`holes` on the print side); `src/stream/subscriptions.ts:29-38` (`print(target)` stored, never re-parsed);
`src/stream/core-processor.ts:324` (`parse(payload.target)` — NO holes, throws on `@`);
`src/stream/stream.ts:448-456` (`#reduceEventIntoCoreReducedState` catches, `reportIssue`s, keeps the state).

**Mechanism** The codec's reservation is enforced only where a STRING is parsed. The array half —
`invoke(["itx","x",["y",{ "@": true }]])`, `subscribe({ target: ["itx","x",["y",{ "@": true }]] })`, or the
string spelling `itx.x({ '@': true })`, which `parse` accepts because no bare `@` appears — carries
the literal as data; `print` then writes it back as `@`. (a) `subscribe` with such a target resolves fine,
the event lands, the reduce's `parse` throws, the throw is swallowed: `subscriptions.list()` is empty and
nothing said so — the "rule that silently never exists" the rules door was built to prevent, for the
other table. (b) `itx.builtins.rewriteRules.resolve(call).at(-1)` prints `…(@)`, and `invoke` of that string
refuses it — the pinned law fails for such a call.

**Proof** `probe-codec.ts`: #11 `parse("itx.x({'\\u0040': true})")` → `["itx",["x",{"@":true}]]`, `print` →
`itx.x(@)`, re-parse → `REFUSED`; #25 the nested form `{a:{'@':true}}` → `itx.x({a:@})` → refused; #31 the
resolver chain for `["itx",["a",{"@":true}]]` prints `itx.a(@)`. The reduce's swallow is `stream.ts:451-455`.

**Suggested fix** Two lines that make it LOUD, one option that makes it right. (i) `subscriptionConfiguredEvent`:
`parse(print(target))` before storing, so an unspellable target fails at the door in the parser's words —
1 LOC, NO-BRAINER. (ii) `print(expr, { holes = false })`: spell the markers only when asked, and ask at the
three target sites (`rewriteRuleConfiguredEvent :293/:306`, `#rewriteRuleList :302`, `#unsetWhatNamesRpcStub :175/:179`);
a call then prints `{'@':true}`, which re-parses as the same literal and the law holds. ~6 LOC. Footnote:
`containsItxExpressionHole` (`expression.ts:80-86`) treats `"...@"` with ANY value as a merge entry while
`printMarkers` only spells `'...@':true` back — align to `=== true` (1 LOC) so the predicates and the printer
agree on what the marker is.

**Failing test** `src/stream/subscriptions.test.ts` —
`test("a target the reduce cannot parse is refused at the door, in either codec half")`:
`expect(() => subscriptionConfiguredEvent({ name: "s", target: ["itx", "x", ["y", { "@": true }]] })).toThrow(/legal only in a rewrite rule's target/)`.
`src/context/expression.test.ts` — `test("a call carrying the literal { '@': true } as data round-trips print → parse")`:
`expect(parse(print(["itx", ["x", { "@": true }]]))).toEqual(["itx", ["x", { "@": true }]])`.

---

### 7. The ARRAY half of a match skips the door; a stored builtins-rooted match makes the DO's un-set throw mid-loop (MINOR)

**Where** `src/context/itx-expression-rewriting.ts:271-289` (`rewriteRuleConfiguredEvent`: the match is
`parseItxExpressionPrefix(match)` — an array passes through un-re-parsed; only `firstStep` is inspected,
and it is inspected as ONE step); `src/stream/core-processor.ts:274-278` (the reduce re-parses the printed
match: any parseable spelling is a row — there is no door at the reduce); `src/iterate-context-durable-object.ts:185-187`
(`#unsetWhatNamesRpcStub`: `rewriteRuleRemovedEvent(rule.match)` evaluated inside the `for`, un-caught).

**Mechanism** `rewriteRuleConfiguredEvent(["itx", "builtins.kv"], "itx.kv")` → `{ match: "itx.builtins.kv" }`
(the reduce stores `["itx","builtins","kv"]`, a row rooted at the fixed point — rule 6's first refusal,
bypassed); `["itx", "cd.x"]` → `itx.cd.x` (the proxy-verb refusal, bypassed); `["itx", "a b"]` → `itx.a b`
(the event lands, the reduce's `parseItxExpressionPrefix` throws, swallowed — no row, no error). The
edge's `provide` is safe because it canonicalizes through the string first (`iterate-context.ts:213`);
the exposure is every other caller (the SDK, tests, a RAW appended `itx/rewrite-rule-configured` — "the
verb minus the handle", which the reduce accepts for any parseable match). Then the second half: a
stored row `itx.builtins.foo ⇒ itx.builtins.rpcStubs.get('k')` names key `k`; when `k`'s last pager
closes, `rewriteRuleRemovedEvent(["itx","builtins","foo"])` throws at the door (`:282-285`) BEFORE
`this.append(...)` is reached — the loop aborts, every later rule and every subscription naming `k`
stays set, and the throw escapes `onPresence → rpcStubPagerClosed → webSocketClose`.

**Proof** `probe-codec.ts` #26 (`{"match":"itx.builtins.kv","target":"itx.kv"}`), #26b (`itx.a b`), #26c
(`itx.cd.x`), #26d (the reduce-side parse throws `unexpected "b" at 6`), #26e (`rewriteRuleRemovedEvent(["itx","builtins","kv"])`
throws the reserved-root refusal).

**Suggested fix** (i) `const matchPrefix = parseItxExpressionPrefix(print(parseItxExpressionPrefix(match)))`
— or simply refuse a name step containing `.`/whitespace — 1 LOC. (ii) In `#unsetWhatNamesRpcStub`, build
the removal event inside a `try` per row so one un-removable row cannot stop the others: 3 LOC. Both
NO-BRAINER.

**Failing test** `src/context/itx-expression-rewriting.test.ts`, the door section —
`test("the door reads the ARRAY half of a match exactly as the string: a dotted name step is refused")`:
`expect(() => rewriteRuleConfiguredEvent(["itx", "builtins.kv"], "itx.kv")).toThrow(/itx\.builtins/)`,
`expect(() => rewriteRuleConfiguredEvent(["itx", "a b"], "itx.kv")).toThrow(/expression:/)`.
`__workers-tests__/rpc-stub-pager-attach.test.ts` — `test("a rule the removal spelling cannot express does not stop the other rows' un-set")`:
raw-append `{ match: "itx.builtins.foo", target: "itx.builtins.rpcStubs.get('k')" }` and a normal `provide("itx.k", stub)`
under key `k`; close the pager; `expect(rewriteRules.get("itx.k")).toBeNull()`.

---

### 8. Non-Latin1 in an expression makes both fetch-lane doors throw a ByteString TypeError instead of answering 400 (MINOR)

**Where** `src/worker.ts:89-90` (`headers.set(ITX_EXPRESSION_FETCH_HEADER, itxExpression)` — the raw `?itx=`
text); `src/iterate-context.ts:188-189` (`headers.set(…, JSON.stringify(itxExpression.slice(0, -1)))` —
`JSON.stringify` does not escape non-ASCII).

**Mechanism** A header value is a ByteString; `Headers.set` with a code point above U+00FF throws
(`Cannot convert argument to a ByteString because the character at index 6 has a value of 26085`). In the
worker's `fetch` that is an uncaught throw → a 1101-style 500 for `GET /expression?context=p&itx=itx.site('日本').fetch`;
in `invoke` it is a rejection with the ByteString text for a terminal `itx.facets.get('日本', spec).fetch(request)`.
The pager attach header does this right (`encodeURIComponent(JSON.stringify(...))`, `rpc-stub-directory.ts:44-45`).

**Proof** node: `new Headers().set("x-itx-expression", "itx.x('日本語')")` throws the ByteString error
(workerd implements the same conversion).

**Suggested fix** `encodeURIComponent` at both doors and `decodeURIComponent` before the `[`-or-parse fork
in `iterate-context-durable-object.ts:698-700`. 4 LOC. NO-BRAINER.

**Failing test** `e2e/review-round2-bugs-edge-side.e2e.test.ts` —
`test("the fetch lane carries a non-Latin1 expression")`: a provided fetch-shaped stub under
`provide("itx.site('日本')", fetchFn)`; `expect((await fetch(expressionUrl(ctx, "itx.site('日本').fetch"))).status).toBe(200)`.

---

### 9. `e2e/support/client.ts`: `until()` hides the cause of a timeout; `readHead` reads one budgeted page (MINOR)

**Where** `e2e/support/client.ts:157-170` (`until`: `.catch(() => undefined)` on every probe; the timeout
error carries only the label); `:107-116` (`readAll` = `readEvents(0, 500)`, ONE page, which since the
memory-budget arc is also byte-budgeted — 8 MiB, down to 512 KiB when other readers are outstanding —
and `readHead` is its last row).

**Mechanism** A probe that throws EVERY time (a codec refusal, `NO_ITX_EXPRESSION_MATCH`, a paused
stream) surfaces 20 s later as `until(x): timed out after 20000ms` with the real error thrown away — the
one thing a reviewer needs to classify a red. `readHead` under-reports the durable head on any log past
500 rows or past the byte budget, so a "facet caught up to `readHead`" assertion can pass before the facet
did; no current test crosses either limit (the largest loop is 120 events), so this is a false pass
waiting for the next big-batch test, not a red today.

**Suggested fix** `until`: keep `lastError` from the catch and append `— last error: ${lastError.message}` to
the timeout. 3 LOC, NO-BRAINER. `readHead`: page on `scannedThroughOffset` until the page is not cut, or
name it `readFirstPageHead` so the limit is visible. ~6 LOC.

**Failing test** `e2e/support/client.ts` has no test file; the sketch is
`await expect(until("probe", () => { throw new Error("NO_ITX_EXPRESSION_MATCH: x"); }, 100)).rejects.toThrow(/NO_ITX_EXPRESSION_MATCH/)`.

---

### 10. The `@` lexer and `matchingParen` do not know JSON5 comments (MINOR — exotic)

**Where** `src/context/expression.ts:45-66` (`lexStringLiterals`), `:107-118` (`matchingParen`), `:146-155`
(the `@` replace runs on every stretch outside a string literal — comments included).

**Mechanism** Args are "ONE JSON5 grammar", and JSON5 has comments. `itx.x(/* @ */ 1)` without holes
is refused as "`@` … legal only in a rewrite rule's target" (the `@` is in a comment); with holes it
silently becomes a marker inside the comment (harmless). `itx.x(1 /* it's */, @)` fails with
`unbalanced "("` — the apostrophe opens a string literal for both walkers and the closing `)` is
"inside" it. Comments in expressions are exotic; the refusals are wrong, not dangerous.

**Proof** `probe-codec.ts` #9, #9b, #10, #22.

**Suggested fix** Either state "no comments in expression args" in the header (0 LOC) or teach both
walkers `//…\n` and `/*…*/` (~10 LOC).

---

### 11. `rewriteRules.get(match)` compares the raw string against canonical keys (MINOR)

**Where** `src/iterate-context-durable-object.ts:364` (`get: (match) => list().find(row => row.match === match)`).

**Mechanism** The table is keyed by `canonicalItxExpressionPrefix` (`provide` at `iterate-context.ts:213`;
the reduce prints the parsed match): `itx.kv.get('a',{a:2,b:1})`. `itx.rewriteRules.get("itx.kv.get( 'a', {b:1, a:2} )")`
answers `null` for the row that exists. The one internal caller (`#removeRuleInBackground`) passes the
canonical string, so this bites only the surface.

**Proof** `probe-codec.ts` #29: `canonicalItxExpressionPrefix("itx.kv.get( 'a' , {b:1, a:2} )")` → `itx.kv.get('a',{a:2,b:1})`.

**Suggested fix** `const key = canonicalItxExpressionPrefix(match)` inside `get` (import exists in the
DO's expression import). 1 LOC. NO-BRAINER.

---

### 12. The `/expression` lane re-enters itself through egress — unbounded recursion (MINOR — pre-existing)

**Where** `src/worker.ts:81-94` (the lane copies `?itx=` into the header on EVERY pass) and
`src/iterate-context-durable-object.ts:701-702, 716` (the header is stripped, the URL — query included —
is not; egress fetches it).

**Mechanism** `GET /expression?context=p&itx=itx.fetch` → the DO → `itx.builtins.fetch(request)` → egress
fetches the request's own URL, which is this worker's lane, which sets the header again → the same DO,
nested inside the outer call → … Self-dial works deployed (the connectors' self-dial tests prove it), so
nothing stops the chain but a platform limit. `itx.fetch` is the first thing a curious caller tries on
the lane. Not today's change (the path suffix only widened the match), but the lane is in scope and this
is a hang.

**Suggested fix** A hop-count header the lane increments and refuses past a small depth (say 4): 5 LOC.
Stripping `context`/`itx` from the forwarded URL is NOT an option — the OpenAPI-behind-the-lane path
needs the query on the way in (finding 4).

**Failing test** `e2e/review-round2-bugs-edge-side.e2e.test.ts` —
`test("the lane refuses to re-enter itself")`: `expect((await fetch(expressionUrl(ctx, "itx.fetch"))).status).toBeGreaterThanOrEqual(400)` within 5 s.

## Notes that are not findings

- **Rule 7's `...@` merge is `Object.assign(out, source)`** (`itx-expression-rewriting.ts:182`): a caller
  object with an own `__proto__` key (JSON5/JSON parse creates one) re-points the merged object's
  prototype (`probe-codec.ts` #32: `polluted` readable, not own). Data leaving through a binding
  serializes own props only. Trusted clients; one `Object.defineProperty` loop if it ever matters.
- **The batch transport** (`library/capnweb.ts:117-144`) drops `send` after its one macrotask
  (`:132-134`); a stub held out of a batch chain fails with capnweb's own "Batch RPC request ended." — the
  documented ONE-SESSION-PER-CHAIN contract, not a defect.
- **`#removeRuleInBackground` is read-then-append over two RPCs**; a re-set that lands between them is
  clobbered — the accepted last-writer-wins window, now narrow.
- **The as-built doc is behind the code in two places**: §6 says the DO un-sets with `{ match, null }`
  (it appends the REMOVAL spelling now) and "an expression rule's handle disposed after another session
  re-set the same match deletes it" (it no longer does — `#removeRuleInBackground`); §5's `facets` row
  still lists `.delete(name)`, which the code says does not exist.

## Repro material

All in the session scratchpad, runnable with the repo's `tsx`:
`fuzz-codec.ts` (40k structural round trips, 0 failures), `probe-codec.ts` (the numbered string-half
probes cited above), `probe-live-args.mts` (finding 1), `probe-library.mts` (findings 3 and 4).
