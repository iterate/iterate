# DO-side bug hunt, round 2 — 2026-09-04

Scope: today's ten commits (`bccbaec0a..HEAD`), the DO / resolver side — the builtins-root resolver
and rule 7 (`@`), the core reduce's masks and hosting-on-the-resolved-target, the one-round-trip
pager attach, the un-set of what names a dead stub, `app-config.ts`, the library tier, and the
`NOT_A_METHOD` root-apply. Nine confirmed defects, ranked; three reproduced with node scripts over
the pure modules, the rest by a precise reading with the exact chain cited. None is fixed here;
nothing under `src/` was modified.

The two that matter: **(1)** the new "compared RESOLVED" un-set in `#unsetWhatNamesRpcStub` resolves
each row against a table it is mutating as it goes, so a user's alias rule (`itx.llm ⇒ itx.ai`) is
deleted as collateral when the fake `itx.ai` stub dies — or survives — depending on which row was
configured first; and **(2)** a library connector reached THROUGH a rewrite rule (the documented
`provide('itx.tools', "itx.connectToMcp(…)")` composition) opens a session per call that nothing
ever closes — for `connectToCapnweb` that is one open WebSocket per call, pinning the DO awake for
its life.

Everything below reproduces on `wip/kernel-wayfinder-2026-07-30` @ `ce089f083` (its `src/` is
identical to `c09629162`, the last of the ten).

---

## Confirmed, ranked by severity

### 1. MAJOR — the un-set of what names a dead stub deletes a user's alias rule, and whether it does depends on configuration order

- **Defect:** `src/iterate-context-durable-object.ts:170-193` (`#unsetWhatNamesRpcStub`) —
  `namesTheKey` (176-183) resolves every row's target through `this.#itxExpressionResolver`, which
  reads the LIVE table (`:376`), while the loop (185-187) iterates a snapshot of the rows and each
  `void this.append(rewriteRuleRemovedEvent(…))` commits SYNCHRONOUSLY (`append` → `Stream.append`,
  no await before the commit) — so later iterations resolve against a table the earlier ones already
  changed.
- **Mechanism.** Misha's flow plus one alias: `provide('itx.llm', 'itx.ai')` (an expression rule the
  user means as "whatever `itx.ai` is") and `provide('itx.ai', fakeStub)`. The stub's last pager
  closes → `#unsetWhatNamesRpcStub('itx.ai')`:
  - rows in insertion order `[itx.llm, itx.ai]`: `itx.llm` resolves `itx.llm → itx.ai → itx.builtins.rpcStubs.get('itx.ai')`
    = the physical key → REMOVED (the removal spelling `itx.builtins.llm` deletes it — `llm` is no
    root, so nothing lies beneath); then `itx.ai` → removed (the restore). `itx.llm.run(1)` is now
    `NO_ITX_EXPRESSION_MATCH`.
  - rows in order `[itx.ai, itx.llm]`: `itx.ai` is removed first; `itx.llm` then resolves to
    `itx.builtins.ai.run(1)` → kept. The real `itx.ai` is back, as the BUILD-LOG promises ("a fake
    `itx.ai` restores the real one").

  The same configuration, two outcomes. The map keeps insertion order, and a re-set keeps a row's
  original position, so which outcome a project gets is decided by which `provide` ran first —
  weeks earlier, possibly. The subscription half (188-192) has the mirror problem in a fixed order:
  rules are removed BEFORE subscriptions are examined, so a subscription spelled through the alias
  (`subscribe({ target: 'itx.cam' })` with `provide('itx.cam', stub)`) never compares equal to the key
  by the time its turn comes — it survives as a dead row that the alarm pass halts with
  `NO_ITX_EXPRESSION_MATCH` (a deterministic failure) instead of being un-set as the header claims
  ("every subscription whose target is `itx.rpcStubs.get('<key>')` is un-set").

- **Proof:** node, over the pure resolver + the core reduce, simulating the loop exactly
  (`scratchpad/repro-alias-collateral.ts`):
  ```
  alias first  rows before ["itx.llm","itx.ai"] → after [];          itx.llm.run(1) now THROWS no rewrite rule matches "itx.llm.run(1)"
  stub first   rows before ["itx.ai","itx.llm"] → after ["itx.llm"]; itx.llm.run(1) now itx.builtins.ai.run(1)
  ```
- **Suggested fix (~12 LOC, `#unsetWhatNamesRpcStub`).** Decide the whole removal set BEFORE
  appending anything, against one frozen table, and count only DIRECT naming: `direct` = rows whose
  printed target IS the physical spelling; every other row resolves with a rules thunk that
  EXCLUDES `direct` (so `itx.llm ⇒ itx.ai` resolves to the platform row beneath and is kept, while a
  user's own `itx.reg ⇒ itx.builtins.rpcStubs` + `itx.reg.get('k')` still resolves to the key and
  goes). Then append the removals. Order-independent by construction.
- **Blast radius.** Every project that aliases a name a live stub sits behind — the "fake `itx.ai`
  in a vitest run" flow the whole arc exists for, once a second rule names `itx.ai`. A durable
  configuration row silently deleted; `rewriteRules.list()` shows it gone with no event naming why.
- **Failing test sketch.** `e2e/rewrite-rules-builtins-root.e2e.test.ts` —
  "an alias to a shadowed root survives the shadow's stub dying, whatever order the two rules were
  configured in": `provide('itx.llm', 'itx.ai')`, then `provide('itx.ai', fake)` from a second
  session; close the second session; `until(rewriteRules.get('itx.ai') === null)`; assert
  `rewriteRules.get('itx.llm')` is still `{ target: 'itx.ai', origin: 'context' }` and
  `rewriteRules.resolve('itx.llm.run(1)').at(-1) === "itx.builtins.ai.run(1)"`. Run the same body
  with the two provides swapped. Today one order fails on the first assertion (`null`).

### 2. MAJOR — a connector reached through a rewrite rule leaks one session per call; for `connectToCapnweb` that is an open WebSocket per call, pinning the context

- **Defect:** `src/context/itx-expression-rewriting.ts:350-369` (`ItxExpressionResolver.invoke`) +
  `src/context/dispatch.ts:44-84` (`walkSteps`) — a mid-chain value that is `Disposable` is never
  disposed; with `src/library/capnweb.ts:40-44,74-92` (a WebSocket session opened at `connectToCapnweb`,
  closed only by `CapnwebConnection[Symbol.dispose]`) and `src/library/mcp.ts:45-47,82-88` (the MCP
  session id, DELETEd only by `close()`/dispose).
- **Mechanism.** The composition the BUILD-LOG proves end to end —
  `provide('itx.tools', "itx.connectToMcp('<url>', { headers })")` then `itx.tools.add({…})` —
  resolves every call to `itx.builtins.connectToMcp(url, opts).add({…})`: the root call step runs the
  connector (initialize → initialized → tools/list = 3 requests), `walkSteps` awaits the connection,
  calls the tool (request 4), returns the value and DROPS the connection. Its `Symbol.dispose` runs
  only when a holder disposes it; an intermediate has no holder. So every `itx.tools.x()` is four
  HTTP round trips and one server-side MCP session that never sees its DELETE. Spell the same
  composition with the WebSocket connector — `provide('itx.shop', "itx.connectToCapnweb('wss://…')")`,
  the natural thing to do with the pet shop's `/capnweb` door — and every `itx.shop.listPets()`
  opens a WebSocket through egress (`webSocketSessionOverEgress`), pipelines one call on it, and
  leaves the socket OPEN: capnweb's `WebSocketTransport` is held alive by the socket's own listeners,
  nothing calls `session.shutdown()`, and an open non-hibernatable socket is exactly what the file
  header says pins the DO ("a held connection pins this context awake for its life"). N calls =
  N open sockets = a context that never hibernates and grows until eviction.
- **Proof:** by reading — `invoke` (363-368) walks and returns; no `Symbol.dispose` anywhere on the
  path; `connectToCapnweb` returns a fresh session per call (the WebSocket branch `:40`); the only
  close is `#dispose` (`:57-59`). capnweb's own `RpcStub[Symbol.dispose]` → `session.shutdown()` →
  `transport.abort()` → `webSocket.close(3000)` (capnweb `src/rpc.ts:297,359-362`,
  `src/websocket.ts` `abort`) — so a dispose WOULD close it; nothing issues one.
- **Suggested fix.** Two honest options. (a) ~20 LOC in `library/capnweb.ts` + ~12 in `mcp.ts`: memoize
  live connections per `(url, transport, headers)` inside `buildLibrary`'s closure (the library is
  built once per DO, so the memo is per context), re-handing the same `CapnwebConnection` /
  `McpConnection` while it is open and dropping it on close/break — the rule-composition path then
  costs one session per context, not per call. (b) ~15 LOC in `ItxExpressionResolver.invoke`:
  collect intermediate values that carry `Symbol.dispose`, and dispose them after the terminal
  `await` — but a final value that is itself a stub of that session (a returned capnweb object) dies
  with it, so (b) needs a rule for that; (a) is the safer first move.
- **Blast radius.** Every rule whose target is a connector call — the "capability = a rule naming a
  connector" pattern the library tier invites. MCP: request amplification ×4 and a server-side
  session leak; capnweb WebSocket: a pinned, socket-leaking context.
- **Failing test sketch.** `e2e/library-connectors-mcp-openapi-capnweb.e2e.test.ts` — "a connector
  behind a rule reuses one session across calls": with a counting MCP fixture (or the pet shop
  behind a counting proxy), `provide('itx.tools', "itx.connectToMcp(url)")`, call `itx.tools.echo({})`
  three times, assert the fixture saw ONE `initialize` (today: three) and, on `session end`, one
  `DELETE` (today: zero). For capnweb, deployed-only: after three `itx.shop.listPets()` through a
  rule, `rpcStubTransportState()`-style socket census (or a fixture that counts open sessions)
  reads 1, not 3.

### 3. MINOR, NO-BRAINER — an MCP tool or an OpenAPI operation named `then` makes the connection thenable: `connectToMcp` / `connectToOpenApi` never settle

- **Defect:** `src/library/mcp.ts:110-119` (`RESERVED_MEMBERS`) and `:124-137` (`withToolMethods`
  defines one prototype method per tool); `src/library/openapi.ts:135` and `:139-152` likewise.
  `then` is not reserved in either set (the dotted-path proxy's `RESERVED` reserves it for exactly
  this reason — `context/dotted-path-proxy.ts:47` — but these connections extend capnweb's
  `RpcTarget`, not `InvokeHandle`, so that guard never applies to them).
- **Mechanism.** `return new Connection(client, tools, serverInfo)` from an `async` function
  (`mcp.ts:46`) resolves the returned promise WITH the connection; a resolved value with a callable
  `then` is adopted: the engine calls `conn.then(resolve, reject)` → the tool method →
  `this.callTool("then", resolve)` → one spurious `tools/call` on the wire, whose result is never
  handed to `resolve`. The outer promise never settles. The same happens anywhere the connection
  is awaited (`walkSteps` awaits every step, `dispatch.ts:55`).
- **Proof:** node (`scratchpad/repro-then-tool.mts`), a fake server listing a tool `then`:
  ```
  connectToMcp with a tool named "then": TIMED OUT; requests seen: ["initialize","notifications/initialized","tools/list","tools/call(then)"]
  connectToOpenApi with an operationId "then": TIMED OUT; requests seen: ["GET /api/then"]
  ```
- **Suggested fix (2 LOC, NO-BRAINER).** Add `"then"` to both `RESERVED_MEMBERS` sets (a tool so
  named stays reachable through `callTool` / `call`, exactly the existing rule for `callTool`
  itself). `invoke`/`applyRoot` in those sets are dead weight (neither class is an `InvokeHandle`)
  and can go.
- **Blast radius.** One remote server with such a name and every `connectTo*` against it hangs the
  caller until the watchdog; the RPC that carried it holds the DO awake meanwhile.
- **Failing test sketch.** `src/library/mcp.test.ts` — "a tool named `then` does not make the
  connection thenable": `TOOLS` + `{ name: "then" }`; `await expect(Promise.race([connectToMcp(itx,
  url), timeout(500)])).resolves.toBeInstanceOf(McpConnection)`; assert no `tools/call` was sent
  at connect. Mirror row in `openapi.test.ts` with `operationId: "then"`.

### 4. MINOR — `hostedFacet` is decided once, at configure time, but the target is re-resolved at every delivery: a row can host a facet it does not own, and the removal effect deletes the wrong one

- **Defect:** `src/stream/core-processor.ts:324-328` (`resolveThroughState(state, configuredTarget)`
  at reduce time, the marker frozen into the row at `:337`) versus `src/stream/subscription-delivery.ts:492-506`
  (the loop resolves `row.target` through the resolver at delivery, so the FACET IT MATERIALIZES is
  whatever the rules say now), with `src/iterate-context-durable-object.ts:267-278` (the removal
  effect trusts the marker) and `:520-548` (M1 recovery resolves the log's target through the
  CURRENT rules).
- **Mechanism.** Two orderings the reduce cannot see:
  - the rule lands AFTER the row: `subscribe({ target: "itx.proc.processEventBatch" })` then
    `provide('itx.proc', "itx.builtins.facets.get('f', spec)")`. The row was stored "as given,
    hosts nothing" (the pinned test at `core-processor.test.ts:507` says so) — but from the next
    commit the loop resolves it to the hosting spelling and materializes `f` (memo written, class
    loaded). On `subscribe({ name, target: null })` there is no marker → `f` and its storage are
    orphaned (the 09-02 "REPLACE orphans the facet" note, now reachable through `null` too).
  - the rule is RE-POINTED after the row was marked: `itx.proc ⇒ facets.get('f', …)`, subscribe,
    then `itx.proc ⇒ facets.get('g', …)`. The marker says `f`, the loop now hosts `g`; on removal the
    DO deletes `f` (whose storage `g` never touched) and orphans `g`. M1 recovery for `g` after an
    eviction likewise reads the NEW rule (`:535`), so `facets.get('f')` — if anyone still addresses
    it — recovers `g`'s source under `f`'s name.
- **Proof:** node over the reduce + resolver (`scratchpad/repro-hosting-frozen.ts`):
  ```
  rule after subscription:        row.hostedFacet = undefined | what the delivery loop will host now: "f"
  rule re-pointed after marking:  row.hostedFacet.name = "f"  | what the delivery loop hosts now: "g"
  ```
- **Suggested fix (~25 LOC).** Make the marker follow the rules: on every `rewrite-rule-configured`
  commit, re-derive `hostedFacet` for every row whose target is not builtins-rooted (a pure pass
  over `state.subscriptions` inside the reduce — cheap, rows are few), so the marker and the loop
  agree at every commit. Alternatively refuse hosting through a rule at delivery (the loop hosts
  only when the STORED row carries the marker) — smaller (~8 LOC in `#invokeFacet`: `spec` is
  honoured only when a row's marker names this facet) but it changes the "a user's own rule naming
  the door hosts like the platform's" promise.
- **Blast radius.** Rule-aliased processors only (`enableProcessor` writes the physical spelling
  and is unaffected). Orphaned facet storage; a wrong facet deleted on disable.
- **Failing test sketch.** `__workers-tests__/review-bugs-do-side.test.ts` — "a facet hosted through a
  rule configured AFTER its subscription is deleted with the subscription": subscribe to
  `itx.proc.processEventBatch`, provide the rule, append one event, assert `facet:f` memo exists;
  `subscribe({ name, target: null })`; assert `ctx.storage.kv.get('facet:f')` is undefined (today:
  the memo survives).

### 5. MINOR — the un-set is fire-and-forget and a paused stream drops it: a rule to a dead stub survives the pause, and `RPC_STUB_OFFLINE` is then permanent

- **Defect:** `src/iterate-context-durable-object.ts:186-192` (`void this.append(…).catch(() => undefined)`)
  with `src/stream/stream.ts:320-327` (the pause-exempt list: created/woken/paused/resumed/halted —
  not `itx/rewrite-rule-configured`, not `subscription-configured`).
- **Mechanism.** A breaker facet trips `stream/paused`; a client's session dies while paused; the
  DO's un-set appends are refused with `STREAM_PAUSED` and swallowed. After `resumed` nothing
  retries: the row `itx.ai ⇒ itx.builtins.rpcStubs.get('itx.ai')` stands with no pager beneath it,
  so every `itx.ai.run(…)` is `RPC_STUB_OFFLINE` until someone re-provides — and, per the arc, the
  removal spelling is now THE restore path for the platform row, so the real `itx.ai` is
  unreachable too. Flagged as an observation on 09-02; today's change raised the stakes.
- **Proof:** by reading; the 09-02 review left it untested and so does this one (the workers-lane
  attach test at `__workers-tests__/rpc-stub-pager-attach.test.ts:68` covers the attach under pause,
  not the detach).
- **Suggested fix (~10 LOC).** On the commit of `stream/resumed` (in `#appendAndRunCommittedEffects`,
  beside the facet-removal effect), re-run `#unsetWhatNamesRpcStub` for every rule/row that names a
  key with no pager and nothing borrowed (`#rpcStubs.listRpcStubKeys()` is the census). Exempting
  the platform's own un-set from the pause would also work but the exemption is by TYPE, and a
  user's `provide(match, null)` shares the type.
- **Failing test sketch.** `__workers-tests__/rpc-stub-pager-attach.test.ts` — "a stub whose last
  pager closes DURING a pause has its rule un-set once the stream resumes": attach with a rule;
  append `paused`; close the pager socket; append `resumed`; assert `rewriteRules.get(match)` is
  `null` (today: the row persists).

### 6. MINOR — a whole-context override that names its own context spins across hops; the depth budget cannot see it, and deleting the `cd` bypass widened it to `append`/`readEvents`

- **Defect:** `src/context/built-ins.ts:345-350` (`cd(p)` → `deps.context(path).invoke(["itx", …])`,
  the own path routed through `localReachableContext(this).invoke` → the DO's `invoke` →
  the resolver, fresh, with a fresh depth counter) with `src/context/itx-expression-rewriting.ts:228-231`
  (the 32-rewrite budget counts rewrites within ONE resolve only).
- **Mechanism.** `cd('/x').provide('itx', "itx.builtins.cd('/x')")` (or the relative
  `"itx.builtins.cd('.')"`, or a two-context ping-pong `/a ⇒ cd('/b')`, `/b ⇒ cd('/a')`) — then
  ANY short-named call on `/x`: `itx.whoami()` → the bare-`itx` row → `itx.builtins.cd('/x').whoami()`
  → `cd` → own context → `invoke(["itx",["whoami"]])` → the row again → … Each hop is an awaited
  async call, so no stack overflow: an unbounded chain of pending promises that outlives the
  caller's timeout and keeps allocating. Before today `cd(p).append`/`read` bypassed the table, so
  at least those two verbs terminated on such a context; now nothing does.
- **Proof:** by reading (the unit table pins the single-resolve budget, `itx-expression-rewriting.test.ts:301`;
  the cross-hop path is a different loop).
- **Suggested fix (~8 LOC).** Refuse, at the door, a bare-`itx` row whose target is `cd` of the
  configuring context's own path (`rewriteRuleConfiguredEvent` does not know the path; the check
  belongs in the proxy's `provide` or the reduce). That closes the one-context loop; the two-context
  ping-pong needs a hop count on `ReachableContext.invoke` (~15 LOC across the seam) and is a
  trusted-client misconfiguration the review would accept leaving.
- **Failing test sketch.** `e2e/rewrite-rules-builtins-root.e2e.test.ts` — "a whole-context
  override naming its own context is refused": `await expect(cd('/x').provide('itx',
  "itx.builtins.cd('/x')")).rejects.toThrow(/own context/)`; today it resolves and the next
  `cd('/x').whoami()` never answers (guard the assertion with a 5 s race).

### 7. MINOR, NO-BRAINER — the relay leaks the session's dup when the DO's fetch itself throws

- **Defect:** `src/context/rpc-stub-relay.ts:141` (`const sessionRpcStub = clientRpcStub.dup()`)
  then `:149` (`await durableObject.fetch(…)`) with no try/catch: the refusal path (`:159-175`)
  disposes the dup only when the DO ANSWERED (a non-101). A rejected fetch — the DO constructor
  throwing (a bad `APP_CONFIG_*` var now does exactly that), an overloaded/reset DO — propagates
  with the dup alive for the session's life.
- **Suggested fix (4 LOC, NO-BRAINER).** Wrap the fetch: `catch (e) { disposeRpcStub(sessionRpcStub);
  throw e; }`.
- **Failing test sketch.** `src/context/rpc-stub-relay.test.ts` — "a DO fetch that rejects releases
  the session's dup": a fake DO whose `fetch` rejects; assert `disposed === true` after the
  rejection (today: false).

### 8. MINOR, NO-BRAINER — OpenAPI: a relative `servers[0].url` on an inline document throws a raw `TypeError: Invalid URL`; a `cookie` parameter is refused as an unknown input key

- **Defect:** `src/library/openapi.ts:177` (`new URL(serverUrl, specUrl)` with `specUrl` undefined)
  and `:105` (`else continue;` — a `cookie` parameter is neither consumed nor deleted from `fields`,
  so `:116-119` refuses it on a body-less operation, or `:113` sends it as the JSON body).
- **Proof:** node (`scratchpad/repro-openapi-edges.mts`):
  ```
  inline doc, relative servers[0].url, no baseUrl:    THROWS TypeError: Invalid URL
  cookie parameter on an operation without a body:   THROWS Error: me has no request body and got unknown input key "session"
  ```
- **Suggested fix (~6 LOC, NO-BRAINER).** In `requestBase`, when `specUrl` is undefined and the
  server url is relative, throw the existing "needs { baseUrl }" message; in `call`, handle
  `in === "cookie"` by appending `name=value` to a `cookie` header and deleting the field.

### 9. MINOR, NO-BRAINER — `itx.rewriteRules.get(match)` compares the caller's spelling to the canonical one

- **Defect:** `src/iterate-context-durable-object.ts:364` (`row.match === match`) — a row's `match`
  is `print(parseItxExpressionPrefix(…))` (single quotes, no spaces, sorted keys); a caller's
  `get("itx.ai.run( 'x' )")` or `get('itx.ai.run("x")')` answers `null` for a row that exists,
  while `provide` accepts every spelling. `list().find` on the client is the workaround nobody
  should need.
- **Suggested fix (1 LOC, NO-BRAINER).** `const key = canonicalItxExpressionPrefix(match)` before the
  `find`.
- **Failing test sketch.** `e2e/rewrite-rules-builtins-root.e2e.test.ts` — "get(match) accepts any
  spelling of the match": `provide("itx.ai.run('x')", …)` then `expect(await itx.rewriteRules.get('itx.ai.run("x")')).not.toBeNull()`.

---

## The `NOT_A_METHOD` root-apply: checked, no halt regression

`src/context/dispatch.ts:92-96` now throws the coded `NOT_A_METHOD` where `callOn` finds neither a
function nor an `InvokeHandle`; the delivery loop lists that code as a deterministic failure
(`src/stream/subscription-delivery.ts:66-73`). Traced every path that reaches `callOn` from the
loop (`#evaluateItxExpressionTargetHead`, `:504`, when the target ends in a call step or is the
two-step `itx.<alias>`):

- `itx.rpcStubs.get('k')` and `itx.<alias>` → a lent stub: `RpcStubHandle` → `applyRoot` — unchanged;
- `itx.<alias>` → `itx.builtins.workers.get(spec).processEventBatch`: the head is the dotted-path
  proxy (a callable), `Reflect.apply` reduces it into `callEntrypoint` — unchanged;
- `itx.cd('/x').append` (a trailing NAME): `walkSteps` on the `cd` handle, not `callOn` — unchanged;
- a head that is a VALUE (`itx.kv`, an `env.AI` binding after a fake dies — finding 1's fallout): was
  an uncoded "target is not callable" → 15 retries over ~30 minutes, then a halt; now a halt at
  attempt 1 with the same `halted` fact. That is the behaviour the memory-hygiene arc asked for and
  the row is still resumable.

The only other consumers of the code are the fetch lane (maps `NO_ITX_EXPRESSION_MATCH` to 404,
everything else 500 — unchanged status) and error text. No caller matched on the old message.

## Checked and found sound (no defect)

- **Rule 7 / the `@` codec.** Round-trips (print → parse with holes → same structure) for: the hole
  inside an array, the hole under a key itself named `@`, a user literal `{'@':1}`, a user key
  `'...@'` with a non-`true` value (kept as a merge entry — the documented reservation is the KEY),
  a string `'{'` immediately before the hole, `{...@,'@':true}` in one object, a string whose
  CONTENT is `{'@':true}`, an empty key. Rewrites: a top-level `@` twice splices twice; a hole in a
  nested array with one arg fills; `@` in the anonymous call step splices; `...@` over an array is
  refused with the documented text; a template with a hole AND steps after the match replays the
  steps; a pinned match plus a template consumes the pin and fills the rest; a whole-context
  override with a template drops the hole on a property access (documented). Two edges worth
  knowing but not defects under the trusted-client doctrine: a caller's arg with an own `__proto__`
  key through `...@` sets the merged object's prototype (Object.assign semantics — the key is
  lost, nothing global is touched); a `Request` through `...@` becomes `{}` (own enumerable
  fields only). (`scratchpad/repro-codec-edges.ts`.)
- **The one-round-trip pager attach.** Accept → stamp → append → presence is one synchronous turn
  (`rpc-stub-directory.ts:204-255`); a refused append closes the socket with the closed-set guard so
  its late close reports nothing, `hadPager` was read before the accept, and no presence event
  precedes the append. The just-accepted `pair[1]` is visible to `#rpcStubPagerFor` for the
  commit's own push: workerd's `getReadyState` (`src/workerd/api/web-socket.c++:946-957`) answers
  `OPEN` for an `Accepted` socket (and even for a pair socket `AwaitingAcceptanceOrCoupling`;
  only `AwaitingConnection` is `CONNECTING`). The 409 body carries the code, the relay re-throws it
  and releases the dup. A malformed header is a 400 before any accept.
- **Masks and the removal spelling in the reduce.** `null` under a root is kept, elsewhere deleted,
  repeats are `undefined` (no checkpoint churn); the platform-equivalent target deletes; a raw event
  with a match at `itx.builtins.…` reduces to a row that can never fire (the fixed point is checked
  before the table) — harmless.
- **`app-config.ts`.** The engine trims, refuses non-strings, unknown `APP_CONFIG_*` names and
  required-blank; `appConfigOf` memoizes per env object and a re-parse on a fresh env object is
  the only cost of that assumption being wrong. A throw in the DO's field initializer runs before
  `setWebSocketAutoResponse` and the wake record — the deployment is loudly dead, as intended; it
  does reach finding 7 on the relay side.
- **The `cd` fast-path deletion.** Grepped every `cd(` user: the proxy's own `cd` is pure addressing
  (`iterate-context.ts:149`), `localReachableContext` reaches the DO's `append`/`read` directly (not
  through `cd`), the SDK host's engine port spells `itx.builtins.…` where it must. Nothing relied on
  the bypass except the loop in finding 6.
- **`libraryItx`.** `deps.invoke(["itx", ...steps])` → the DO's `invoke` → the resolver: a shadowed
  `itx.fetch` redirects the library, egress otherwise, zero hops, the `Request` arg never crosses a
  boundary.
- **The batch capnweb transport.** Mirrors capnweb's own `BatchClientTransport` line for line
  (`capnweb/src/batch.ts:11-64`): the macrotask wait, the silent post-batch `send`, the "Batch RPC
  request ended." on exhaustion; `receive()` is awaited by capnweb's read loop, so a rejected POST
  is handled, never an unhandled rejection.

## Observed, out of scope (owned by another session — `subscription-delivery.ts`, not touched)

- `#pushSubscriptionNames` (`:134`) is only ever ADDED to. A row classified as a push row (its target
  resolved to a facet or a lent stub) that a later RULE re-point turns into a cursor target keeps
  its classification: `onCommit` neither remembers the batch nor arms the alarm for it (`:217-222`),
  and the alarm's row pass skips it (`:335`). `#deliverEventBatch` re-evaluates (the rules ref moved)
  and the cursor lane adapts, but at-least-once across an eviction is gone for that row until it is
  reconfigured. Pre-existing; today's rules-first resolver makes such re-points more common.

---

## Commands run

```
# baseline: the tree as found (other sessions editing; nothing under src/ changed by this review)
git rev-parse --short HEAD                                     # ce089f083 (src identical to c09629162)

# node repros over the pure modules, from packages/v3/project-worker
node_modules/.bin/tsx <scratchpad>/repro-alias-collateral.ts   # finding 1: two orders, two outcomes
node_modules/.bin/tsx <scratchpad>/repro-then-tool.mts         # finding 3: both connectors TIMED OUT
node_modules/.bin/tsx <scratchpad>/repro-hosting-frozen.ts     # finding 4: marker vs. what the loop hosts
node_modules/.bin/tsx <scratchpad>/repro-openapi-edges.mts     # finding 8: TypeError, cookie refused
node_modules/.bin/tsx <scratchpad>/repro-codec-edges.ts        # the `@` edge table above — all sound
```

Scratchpad: `/private/tmp/claude-501/-Users-jonastemplestein--herdr-worktrees-iterate-simplification/915ddd3a-765a-497b-866c-2f7e52ac434b/scratchpad/`.
No test file was added and nothing under `src/` was modified (the brief: one new file, this report).
