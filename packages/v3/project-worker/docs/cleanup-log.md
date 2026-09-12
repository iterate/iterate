# Clean-room cleanup log

Multi-round idiomatic/anti-slop cleanup of the clean-room worker (packages/v3/project-worker),
aligning to apps/os conventions. Each round: obvious style/TS → just fix; obvious cleanup/refactor →
just do; obvious bug → failing test + fix; bug needing a larger refactor → expected-fail test that
pins it + a note here; API/abstraction/concept questions → research + note here for discussion.

## Owner directives shaping this pass (tabula rasa — no backwards compatibility)

- Events + built-in capabilities must be **fully type-safe**; `as` casts and `any` are a smell that
  means it's done wrong. No compat shims — prd is resettable.
- No event-builder helpers: write events literally (`itx.append({ type, payload, idempotencyKey })`)
  so the type string and payload are always visible; `itx.append(...)` is the verb (not the
  `invoke(["itx",["append",…]])` spelling).
- `defineProcessorContract` follows apps/os (events map with payload schemas, `processorDeps`,
  contract-bound `buildEvent`, derived `ConsumedEvent`/`ProcessorState`), minus any gross bits.
- No single-use / extremely-thin helpers or indirection constants — inline them.
- One documented **types-and-schemas** file (kept at `./types`) is the surface to read AND to import
  from the frontend: the RPC hierarchy (IterateRpcTarget → SessionRpcTarget → IterateContextRpcTarget),
  auth (SessionCredentials/Principal/ProjectTokenClaims), routing (project-host resolution), domain
  (Project/Org/User/Reach), core event types, and the processor contracts — with prose + code examples.
- Fewer files: consolidate small, related ones.

## Round 1 — codex astra (gpt-6-astra, xhigh) + subagents

### Done this round

- **Event-builder helpers deleted (account).** `authenticatedEvent` / `tokenCreateRequestedEvent` /
  `tokenRevokedEvent` gone; every append writes a literal `{ type, payload, idempotencyKey }` beside
  it, via `itx.append(...)` (the client sugar) — the type string and payload are visible. contract.ts
  now holds only the payload types + the reducer. (codex #7, owner's directive.)
- Adopt the apps/os `defineProcessorContract` (events map with payload schemas, `processorDeps`,
  contract-bound `buildEvent`/`parse*`), replacing the hand-written discriminated union. (owner ask.)
- Style: drop `useMemo<any>` in account/sessions (infer from the typed `api`), and spell notes KV as
  `itx.kv.get/put(...)` not expression arrays. (codex #9.)
- `AccountView.authentications` → a count, not a growing array the UI only measures. (codex #10.)
- Inline the remaining core event builders (`rewriteRuleConfiguredEvent`, `rewriteRuleRemovedEvent`,
  `subscriptionConfiguredEvent`). (codex #7.)

### Deferred — bugs needing a larger refactor/decision (pinned as expected-fail where testable)

- **[bug] Idempotent-retry re-runs effects on returned echoes.** `Stream.append()` returns historical
  events on an idempotency hit and the DO reruns deployment/cleanup effects on those echoes — configure
  source A, replace with B, retry A → the startup memo reverts to A while reduced config stays B.
  Fix: distinguish fresh commits from echoes; run effects only on fresh commits.
  (codex #2, src/iterate-context-durable-object.ts:259)
- **[bug] Malformed core control events commit as durable no-ops.** Core payloads are cast, not
  validated; a subscription-config event missing `target` commits and acknowledges but does nothing.
  Fix: discriminated schemas for core-owned events, validated at the append boundary; keep app payloads
  opaque. (codex #3, src/stream/stream.ts:267, src/stream/core-processor.ts:281)
- **[bug] Library WebSocket connections escape idle cleanup.** The DO idle alarm tracks facets +
  borrowed stubs but not library outbound WebSockets, so a connection-only context can pin
  indefinitely. Fix: include library connections in the idle clock + alarm eligibility; await async
  connection cleanup. (codex #5, src/iterate-context-durable-object.ts:493, src/library.ts:87)
- **[bug] Disposing during STREAM_PAUSED strands rule/subscription cleanup.** Disposers swallow append
  failures; during a pause, expression-backed handles lose cleanup permanently (the resume sweep only
  repairs rows naming dead RPC stubs). Fix: internal cleanup survives pauses/transient failures with
  bounded retries + terminal reporting, keeping the compare-and-set guards. (codex #6, src/iterate-context.ts:359)
- **[bug] mini-app add() loses concurrent writes.** The example reads the whole notes array and
  overwrites one KV key. Fine for a demo, wrong as a reference. Fix: per-note keys, or append events
  and derive the list. (codex #12, examples/mini-app.ts:38)

### Deferred — API/abstraction questions for discussion

- **Three overlapping token/credential systems.** (a) `Grants.mint/list/end` — real OAuth grants used
  by /mcp and the /sessions grants table; (b) `IterateContextRpcTarget.mintToken()`/`rotateApiKey()` +
  `ProjectDoorsInput` — project credentials whose verifiers have no current admission callers; (c) the
  new LiveState account tokens (readable, insecure-first, owner-requested). codex recommends collapsing
  onto (a) and deleting (b)+(c)'s duplication; the owner explicitly wants the LiveState (c) path for the
  live UX. DECISION NEEDED: which is canonical, and does the LiveState token become a real credential
  (a minting EFFECT that writes a hash) or stay a readable placeholder? (codex #4, #8)
- **Account/organization handles are unrestricted global itx.** `session.user` / `session.organizations`
  return full global-context itx; `.cd("/users/<other>")` reaches any subtree. This is the KNOWN deferred
  path-mask enforcement (already pinned as control-plane security-spec expected-fails). Left as-is until
  the enforcement pass. (codex #1, src/session.ts:260)

### Deferred — cleanup (do in a later round)

- **Trim source-file prologue essays.** library.ts, iterate-context-durable-object.ts, stream/processor.ts
  open with long uppercase narration/roadmap prose. Keep the hard-won gotcha notes (RPC disposal,
  memory, hibernation); delete the repeated architecture/roadmap essays (move to docs). (codex #11)

## Round 2 — type-safety pass + apps/os "neat tricks" mining

### Done this round

- **Type-safety: the project token is zod-parsed, not cast.** `verifyProjectToken` ran
  `verifyClaims()`'s `unknown` through a hand-rolled `typeof` chain behind `as ProjectTokenClaims`.
  `ProjectTokenClaims` is now a zod schema (`export const … = z.object(...)` + `z.infer` type) and the
  verifier `safeParse`s — a security-sensitive path now validates like the rest of the code.
  (owner "casts are a smell", src/principal.ts)
- **mcp.ts single-use helpers inlined.** `objectSchema`/`textResult`/`failure` folded into the one
  `run` tool; `JsonSchema` colocated beside `buildServer`. (owner "no single-use helpers")
- **DO fetch-lane header casts documented.** Why-safe comments on the two edge→DO header casts
  (`x-itx-expression`, `x-itx-principal`): edge-set + resolver-validated / loaded-code stripped.
  (src/iterate-context-durable-object.ts)
- **[bug] RPC import-table leak in subscription delivery — FIXED.** Every delivery lane (live-client
  push, facet push, cursor lane) awaited `call([events, range])` only for the ack and dropped the
  return — but a Workers-RPC/capnweb result pins the callee's export until disposed, so each delivered
  batch leaked one import-table slot (and a live client's push runs on every commit). Fixed at the
  single source — the `call` closure disposes its own ignored result; `call` narrowed to
  `Promise<void>`. Verified: unit delivery/stream/budget 60 passed, workers push lanes 10 passed.
  (apps/os-tricks #1 `disposeIgnoredRpcResult`, src/stream/subscription-delivery.ts)

### apps/os tricks — triaged (subagent report, owner asked us to mine apps/os)

Adopted:
- **#1 dispose-ignored-RPC-result** — done above (the real leak). We keep the idiom INLINE (the
  clean-room is standalone, no `iterate` dep; the guard+dispose is 3 lines and matches the existing
  facet-invoke lane) rather than importing apps/os's helper.

Deferred — worth doing, later round:
- **`Redacted<T>` secret wrapper.** apps/os wraps secret strings in a branded box whose `toString`/
  `toJSON` redact, so a secret can't be logged or serialized by accident. We handle secrets in
  principal.ts (API keys, token secrets) and context/built-ins.ts (secret substitution); a `Redacted`
  box would make "never log a secret" a type guarantee, not a discipline. Medium effort (wrap at the
  boundaries). Aligns with the type-safety directive. LOG for a later round.
- **truncate-json / infer-json-type for MCP run results.** apps/os trims oversized tool results and
  annotates their shape so an agent isn't handed a 2 MB blob. The clean-room MCP `run` tool returns the
  raw JSON round-trip; large results are handed through whole. Nice-to-have for agent ergonomics; not a
  bug. LOG.
- **Declarative processor test harness.** apps/os has a table-driven `{ events → expected state }`
  harness for processors. Our processor tests are hand-written. Would tighten the account/presence
  processor tests. Test-infra, LOG.
- **wide-log (one structured event per unit of work).** apps/os emits one wide structured log per
  request/delivery with all dimensions attached, vs our scattered `console.warn({...})`. Observability
  win, bigger surface. LOG.

Not adopting:
- **`withOwnedRpcSession` / `retainCallback` as imported helpers.** The clean-room already owns its
  session lifecycle inline (library.ts reopen/dispose) and its live callbacks via the delivery lane;
  importing apps/os's versions would add a dependency and indirection for no new behavior. The one real
  defect they'd have caught (the ignored-result leak) is fixed directly.

## Round 2 (cont.) — codex astra round 2: five findings, verified

Codex round 2 (gpt-6-astra, xhigh) over the improved state found five bugs, each with an
in-memory repro. Every one was re-verified HERE by reading the code (not taken on trust).

### Fixed with tests
- **[bug] #5 waitForEvent ignored afterOffset on the waiter path.** The filter documents
  "offset strictly greater than afterOffset"; the sync scan honored it but a registered waiter
  stored only `type`, so an afterOffset ahead of head (or left behind by an ephemeral-offset
  rewind) resolved on an earlier fresh event. FIXED (waiter carries afterOffset; resolve requires
  `offset > afterOffset`) + failing test. (stream.ts)
- **[bug] #4 live-state delta appends could reorder.** The ordering path cleared an in-flight flag
  in the first append's `finally` while a later delta was still queued, so a newer delta forked a
  parallel chain and could overtake it (commit order 1, 3, 2). FIXED by always chaining (flag +
  fast path removed — simpler and race-free) + serialization-contract test. (processor.ts)
- **[bug] #3 concurrent MCP requests raced the re-handshake.** initialize() cleared #closed at its
  START, so a second concurrent request after a close skipped the handshake and posted session-less
  (a real MCP server 400s). FIXED with a shared #handshake promise, #closed flipped only after the
  handshake completes, close() clearing the memo + a DETERMINISTIC failing test (delayed initialize,
  session-gated fake server). (library.ts)
- **[bug] #1 cursor lane could skip history on a reconfigure.** If the old cursor loop was suspended
  on the cursor-read-budget acquire when a reconfigure landed, it resumed with a stale cursor/row and
  its empty-batch adopt wrote the old scan offset into the fresh record — a replacement's
  afterOffset:0 history skipped. FIXED with a configuredAtOffset re-check after the budget await
  (the file's own guard idiom); the window needs budget contention, so covered by inspection + the
  existing replace/afterOffset suite rather than a bespoke contention repro. (subscription-delivery.ts)

### Fixed (safe systemic version — the scoping blocker turned out avoidable)
- **[bug] #2 consumed event payloads were not validated before reduce.** `#reduceOrKeep` guarded a
  THROWING reducer but never checked the payload, so a malformed payload for a KNOWN, owned event
  (e.g. an account token event with `name: {bad:true}`) folded into reduced state — which then
  violated the EXPORTED `AccountView` schema and crashed a live client parsing it. FIXED: exposed the
  contract's owned+dep `resolve` as an optional `payloadSchemaFor(type)` on the base ProcessorContract
  (kernel-generic contracts omit it → reduce unvalidated, as before), and `#reduceOrKeep` now validates
  `event.payload ?? {}` against it, skipping + reporting a malformed payload instead of folding it. The
  scoping blocker (the demo's payload-less `{ type: "tick" }` vs the presence `z.object({})` schema)
  was avoided by validating `payload ?? {}` — the same "empty defaults to {}" convention the contract
  already requires of its stateSchema — so a payload-less event validates as `{}`. Audited: only Account
  and Presence declare events catalogs; all real appends match, workers lane shows 0 payload rejections.
  Failing test added + full unit/workers lanes green. (processor.ts)
  NOTE: this covers CONTRACT (app) events. Core-owned CONTROL events (subscription-configured, etc.) go
  through the hand-built core reduce, which has no events catalog — that validation (the round-1 deferred
  "malformed core control events commit as no-ops") is still open and wants discriminated schemas.

## Round 3 — codex astra round 3: five NEW findings, all fixed

Codex round 3 (gpt-6-astra, xhigh) over the round-1+2 state found five NEW bugs (nothing
already logged). Each re-verified here, then fixed with a test where deterministic:

- **[bug] #3 reducer got z.input, not z.output.** Round-2 validation gated but folded the RAW
  event, discarding a schema transform (`z.coerce.number()`: "2" + 3 → "023"). Now the NORMALIZED
  event (payload = parsed.data) reaches both the reducer and the effect hook; a malformed payload is
  still not folded but the raw event flows to processEvent so batch caught-up signalling is intact.
  Coercion test added. (processor.ts)
- **[bug] #5 buildEvent lied about its return type** (promised the input type, returned the
  schema-transformed payload). buildEvent had ZERO call sites (events are written literally), so it
  was DELETED along with its orphaned BuildEvent/ResolvedType/DepEventType types — payload validation
  now lives at reduce (payloadSchemaFor). (processor.ts)
- **[bug] #4 the live-state client cast network frames** `as LiveStateDelta`; a non-numeric `to`
  poisoned the held rev and silently wedged every later frame. Now zod-parsed at the boundary; a
  malformed frame HEALS through the seed door (the store's existing gap recovery). Failing-mode test
  added. This is version-skew robustness, not malicious-client defense. (client/live-state.ts)
- **[bug] #1 deleted secrets could reappear** (P1). set/delete each do append-THEN-KV as two awaits,
  unserialized on the root DO; a concurrent pair could land the KV writes opposite to the log order,
  leaving egress a value the catalog says is gone. Serialized per name on the root DO (the chain lives
  in #builtIns, one per DO instance). FOLLOW-UP: an eviction BETWEEN a delete's append and its KV
  delete can still strand a value — a durable reconciliation sweep on startup (walk catalog-deleted
  secrets, ensure KV deleted) is the deeper fix; deferred. (context/built-ins.ts)
- **[bug] #2 an older facet load could clobber a newer one.** A stale load's post-load check only
  confirmed the facet still existed; a reconfigure during the load then had its newer code aborted and
  replaced by the older. Now the post-load check compares the desired spec (facet:<name>) to what was
  loaded and bails if it moved. (iterate-context-durable-object.ts)

### RPC-result-not-disposed warnings (owner asked to avoid them)
- FIXED the DETERMINISTIC one: the logout batch left `api.authenticate(...)`'s SessionRpcTarget stub
  undisposed — now `using session = api.authenticate(...)` (browser-session.ts). Was 1/1 in the
  workers lane; gone after.
- A RESIDUAL warning appears INTERMITTENTLY in the FULL workers lane (0 in some runs, 1 in others) and
  is NOT attributable to a production code path: it is GC-timed and surfaces during teardown of the
  tests that deliberately hang/cancel workers (uncontrolled-degradation) — a DO destroyed mid-RPC
  cannot dispose the peer's in-flight result. `uncontrolled-degradation` ALONE is clean; it only shows
  under the full run's teardown interleaving. Treated as a harness teardown artifact, not a leak in a
  path production exercises. Revisit if it ever turns deterministic.

## Round 4 — codex astra round 4: five NEW findings, all fixed with tests

Several are direct adjacent-gaps of the round-2/3 fixes (the nature of deep review — each fix reveals
the next seam). All re-verified, all fixed:

- **[bug] #1 (P1) version replay bypassed payload validation.** Round-3 put validation/normalization in
  #reduceAndProcessEvent, but #rereduceIfVersionChanged reduced RAW — a coercing schema gave a number
  live and a raw string after a version bump ({n:"2"} → 2 live, "02" on replay), silently rewriting
  state. Extracted #validateNormalizeAndReduce; live AND replay both route through it. Replay-coercion
  test. (processor.ts)
- **[bug] #5 dep-vs-dep event clashes were allowed.** The one-owner guard only caught local-vs-dep; two
  processorDeps declaring the same type with different schemas passed, and `resolve` picked the first
  while ConsumedEvent's union held both. Rejected at defineProcessorContract. Test added. (processor.ts)
- **[bug] #2 child secrets cached a broken root stub.** `deps.context("/")` was captured once at
  buildBuiltIns; after a root DO failure it stayed broken until eviction. Acquire it PER CALL
  (Cloudflare DO error-handling). (context/built-ins.ts)
- **[bug] #4 child secret mutations lost caller attribution.** The child forwarded to the root WITHOUT
  a Caller, so the durable secrets/changed event dropped the authenticated principal. Forward
  deps.caller(). (context/built-ins.ts)
- **[bug] #3 closing during an MCP re-handshake revived the client + leaked a session.** A handshake in
  flight when close() ran completed afterwards, set #closed=false + #sessionId=s-2 (close had DELETE'd
  s-1, could not know s-2). close() now bumps a #generation; a stale handshake refuses to revive and
  DELETEs the session it established. Deterministic test (both s-1 and s-2 get DELETE). (library.ts)

Round tally so far: R1 12 · R2 5 · R3 5 · R4 5 — all fixed or deferred-with-reasoning above.

## Round 5 — codex astra round 5: five findings (4 fixed, 1 pinned)

Three of these were incomplete-fix follow-ons in the areas rounds 2–4 kept touching — now given deeper,
more fundamental fixes (a single validation path, handshake session-ownership, a guarded decode), which
should end the re-open cycle in those areas:

- **[bug] #1 (P1) malformed events reached the TYPED effect hook.** Round-4 kept processEvent running on
  a malformed payload (passing the raw event); processEvent is typed against ConsumedEvent's z.output, so
  a hook reading the promised shape threw and WEDGED the batch (checkpoints never advance, catch-up
  refails the row). Now #reduceAndProcessEvent returns { state, processed } and skips BOTH reduce and
  effect for a malformed event; the batch falls back to the eventless caught-up pass. Test added. (processor.ts)
- **[bug] #4 an absent live-state payload threw past recovery.** The round-3 boundary parse did
  JSON.parse(JSON.stringify(payload)) before safeParse — an omitted payload made JSON.parse("undefined")
  throw and escape the callback, skipping later deltas. Guarded the whole decode; a malformed/undecodable
  frame heals via the door. Test added. (client/live-state.ts)
- **[bug] #2 (P1) a stale MCP handshake clobbered the live session.** Round-4's generation counter still
  shared #sessionId across concurrent handshakes (#post wrote it for both), so "A parks, close, B goes
  live, A resumes" had A overwrite + null B's live #sessionId. REDESIGNED: #post no longer touches
  #sessionId (it takes+returns the id); each handshake owns its session id, DELETEs only its own on a lost
  close race, and publishes to #sessionId only on a non-stale commit. Deterministic test added. (library.ts)
- **[bug] #5 MCP results were cast, not parsed.** listTools/callTool/initialize cast an EXTERNAL (untrusted)
  MCP server's JSON to their promised types; an off-spec server handed a typed frontend the wrong shape.
  Now zod-parsed at every boundary (McpTool/MCPToolsList/MCPServerInfo/MCPToolResult). Test added. (library.ts)

### Pinned — a deeper WS-relay race, deferred for an e2e-verified fix
- **[bug] #3 the fetch-upgrade relay can drop an early server frame.** RpcStubFetchServer.serve accepts the
  EYEBALL socket only AFTER `await transport.fetch(...)` opens the LEG, so a frame the remote sends the
  instant the leg connects finds no peer (#peerOf → null) and is dropped. The PRIMARY transport (capnweb)
  is client-first — the server never sends before the eyeball's first call — so this bites only RAW WS
  proxying to a remote that greets. RECOMMENDED FIX: accept the eyeball BEFORE calling transport.fetch
  (close it if the fetch rejects), so the peer exists when the greeting arrives — BUT this depends on
  workerd buffering frames sent to an accepted eyeball before its client half reads the 101, which must be
  proven by an e2e against real workerd (this hibernatable relay is inherently flaky to unit-test —
  reference_live_hibernation_proof_inherently_flaky). Not rushed into the relay. (context/rpc-stubs.ts:862)

Round tally: R1 12 · R2 5 · R3 5 · R4 5 · R5 5 (4 fixed + 1 pinned) = 31 fixed, 1 pinned.

## Round 6 — codex astra round 6: convergence check (5 findings, all fixed)

The convergence signal we were after: codex reported "no new issue in the shared processor
validation/replay/effect path" — that redesign (round 5 #1) has CONVERGED. The remaining findings were
in the MCP client + live-state (some follow-ons to round-5 fixes) plus one pre-existing OpenAPI one:

- **[bug] #1 (P1, round-5 regression)** MCPToolResult stripped non-text content (image data/mimeType).
  Content items → z.looseObject (type validated, other fields preserved). Test added.
- **[bug] #2** initialize() cleared #handshake unconditionally; a stale handshake's rejection wiped its
  replacement's memo. Now cleared only when the memo still references THIS handshake. (library.ts)
- **[bug] #3** a setup failure left the allocated MCP session undeleted. #runHandshake DELETEs its own
  session on ANY post-allocation failure; connectToMcp closes the client on discovery failure. Test added.
- **[bug] #4** store.apply → applyPatch throws on a refused patch (/__proto__), escaping + skipping later
  frames. Contained per frame → heal via the door. Test added. (client/live-state.ts)
- **[bug] #5 (pre-existing)** OpenAPI listOperations returned { name: undefined } for a $ref parameter.
  Parameters zod-parsed; $ref/malformed dropped (already a no-op in the request builder). Test added. (library.ts)

### Meta-observations for a later DISCUSSION (not code this pass)
- **The MCP client's session/handshake lifecycle has taken 5 rounds of edge-fixes** (concurrent request,
  close-during-handshake, stale-clobber, memo-clearing, setup-leak). Each fix has been correct and is
  now tested, but the sheer number of concurrency edges suggests the lifecycle would benefit from a
  HOLISTIC redesign review (e.g. a single owned "session epoch" object that encapsulates handshake +
  session-id + close, instead of several interacting private fields). Worth a design pass before adding
  more MCP features. NOT urgent — the current code is correct and covered.
- **OpenAPI `$ref` resolution is unsupported** — $ref parameters (and, more broadly, $ref anywhere in the
  document) are dropped, not resolved. A full fix zod-parses the whole OpenAPI document at the boundary
  and resolves (or explicitly rejects) $refs. Deferred feature. (library.ts listOperations)

Round tally: R1 12 · R2 5 · R3 5 · R4 5 · R5 5 · R6 5 = 36 fixed, 1 pinned (WS-relay), 2 discussion items.

## Round 7 — STYLE / IDIOM / CONCISENESS pass (reoriented codex, not correctness)

Course-correction: rounds 2–6 over-indexed on correctness bugs; this round is the style/cleanup the
goal actually asked for (apply apps/os idioms, kill cruft, make concise, consolidate). Confirmed apps/os
is overwhelmingly LITERAL events (`.append({ type, payload })`; `buildEvent` used once) — the clean
room's direction. The account trivial builders (`tokenRevokedEvent` etc.) were already deleted + literal
in round 1 (the owner's exact example is fixed).

### Done this round (obvious style wins)
- **demo.tsx**: buttons call `itx.append({ type: "tick" })` DIRECTLY (was `itx.invoke(["itx",["append",
  event]])` behind a wrapper) — the append verb + event visible at the call site.
- **account/contract.ts**: `AccountView.tokens`/`authentications` ARE their events
  (`z.array(TokenCreateRequest)` / `z.array(AuthenticationFact)`); the reducer folds `event.payload`.
  No triple re-spelling. (account processor bundle 2.0→1.6 KiB.)
- Inlined single-use indirection constants (`MCP_PROTOCOL_VERSION`, `CLIENT_INFO`, `PROJECT_INPUT`).
- Inlined single-use `exchangeToken`; dropped the `authorizationCodeRequest` re-export.

### Examined, judged NOT cruft (kept, with reasoning)
- `#publishAuthenticationFact` (session.ts): writes the `authenticated` event LITERALLY inside, and does
  real plumbing (email guard, DO routing, waitUntil, idempotency) parameterized only by `credential`,
  used 2×. Inlining would duplicate the plumbing. Kept.
- `const env = this.#env` locals (grants.ts/consent.ts): used 4–5× per method; the HARD "fully-qualified
  names" rule is about not ABBREVIATING the field (`#borrowed` vs `#borrowedRpcStubs`), not banning
  locals. Not a violation. Kept.
- `runScriptModule`'s `[...lines].join("\n")` (library.ts): a fine idiom for a GENERATED module; dedent
  risks whitespace changes to code that must parse, and isn't in the library import allowlist. Kept.

### Larger refactors / decisions — RESEARCHED, logged for a focused pass (per the rubric)
- **The 3 core event builders** (`subscriptionConfiguredEvent`, `rewriteRuleConfiguredEvent`,
  `rewriteRuleRemovedEvent`). Unlike the trivial account builders, these do append-time VALIDATION
  (roots/holes/proxy-verbs) and normalize itx-expression targets STRING→array BEFORE storage — essential
  because a facet-hosting target carries the whole facet SOURCE, which the reduce must never string-parse
  (the codec's 2 KiB cap). CONCRETE FINDING: the core reduce ALREADY re-normalizes these targets
  (core-processor.ts:347/373/397), so the builder's normalization is partly redundant. RECOMMENDED
  refactor (unifies both + resolves the round-1 deferred "malformed core control events" bug): ONE
  append-boundary discriminated normalizer/validator for `events.iterate.com/stream|itx/*` control
  events, so call sites write LITERAL `{ type, payload }` and the boundary validates+normalizes once
  before Stream.append. Scope: the append path + ~11 production + ~30 test call sites. Risky (core append
  path); do as a dedicated, well-tested pass. NOT rushed.
- **app-config.ts three representations** (var whitelist + interface + imperative parser). A single zod
  env schema would derive keys/types (apps/os style). BUT app-config is a critical path (a bad parse →
  every route 500s) and has NO unit test — do it only AFTER writing a test that pins the current
  validation + exact error messages, then refactor keeping it green.
- **library.ts (≈900 lines, 3 protocols)** → extract capnweb/mcp/openapi modules for cohesion. Judgment
  call: it improves cohesion but adds files (vs the owner's "fewer files") and the import-boundary test
  reads library.ts whole. Recommend extracting; needs the boundary test updated to cover the new modules.

## Round 8 — STYLE round 2: converged

Codex style round 2 reported the pass "close to converged": three small wins (done above — DRY the
account `consumes`, inline the `hostedFacetName` getter + `CORE_SLUG` constant, drop the
`ItxExpressionRewriteRule` re-export), NO new event builders, and no compelling small-file
consolidation beyond the already-logged larger items. The style/idiom/conciseness pass has converged;
the remaining shape work is the three LOGGED larger refactors (core-builder append-boundary
unification; app-config→zod; library.ts protocol split) — each a decision/dedicated pass, not a quick
cleanup.

## Round 9 — the core-builder append-boundary unification (the headline refactor: DONE)

The #1 logged larger refactor, executed. The three core event builders are gone; every call site now
writes a LITERAL `itx.append({ type, payload })` — the event type string and payload body are visible
at the point of use, exactly the goal ("the more we can _see_ events … the better").

### What replaced the builders
- **`normalizeControlEvent(event)`** (stream/core-processor.ts) — ONE discriminated normalizer/validator
  for the `stream/subscription-configured` and `itx/rewrite-rule-configured` control events. The DO runs
  it on EVERY append (`this.#stream.append(...events.map(normalizeControlEvent))`) and on the
  constructor's birth events, so a literal `{ type, payload }` is validated + normalized (match →
  canonical string key, target STRING→parsed array before the 2 KiB codec) exactly once, at the door,
  before `Stream.append`. Idempotent (a normalized event re-normalized is itself).
- **`normalizeRewriteRuleConfigured(payload)`** / **`normalizeSubscriptionConfigured(input)`** — the
  builders' validation+normalization bodies, now pure functions returning a payload (no event wrapper).
- **`restoreRuleTarget(match)`** — the platform-equivalent target `["itx","builtins",...match.slice(1)]`
  a rule REMOVAL names (the reduce turns it into a deletion). Replaces `rewriteRuleRemovedEvent`; a
  compare-and-set undo passes `ifTarget` in the literal payload.

### Deleted
`subscriptionConfiguredEvent`, `rewriteRuleConfiguredEvent`, `rewriteRuleRemovedEvent` and their imports
across production (iterate-context.ts, iterate-context-durable-object.ts, built-ins.ts) and ~7 test
files (call sites rewritten to literals + `normalizeControlEvent`/`restoreRuleTarget`).

### Bonus: the round-1 deferred "malformed core control events" bug is now CLOSED
Because validation moved from the builder (which only the trusted edge called) to the DO append
BOUNDARY, a raw invalid control event is now refused for EVERY caller — a Workers-RPC caller can no
longer append a rule whose match is rooted at `itx.builtins` (the reserved fixed point). That is a real
behavior change: `rpc-stub-pager-attach`'s "a raw row the removal spelling cannot express" scenario is
now IMPOSSIBLE, so that test was rewritten to prove the door REFUSES the illegal match (and that a real
rule's un-set sweep is untouched).

### Gates
unit 543 passed | 5 xfail · workers 77 passed | 13 xfail | 2 skip · typecheck PASS · oxlint 0/0 · knip clean.

### What remains (unchanged from round 8)
Two logged larger refactors, each a dedicated pass: **app-config.ts → one zod env schema** (needs a
pinning test first — a bad parse 500s every route) and **library.ts protocol split** (cohesion win vs
the import-boundary test that reads the file whole). Both are decisions/dedicated passes, not quick
cleanups. The style/idiom/conciseness sweep and the headline event-builder cruft are DONE.

### Round 9 codex review (xhigh, gpt-6-astra) — 2 findings, both actioned

A focused codex read of the round-9 commit. It confirmed `ifTarget` survives end-to-end (stale +
current + `null`-mask removal cases all pass), no deleted-builder references remain, and `restoreRuleTarget`
earns its keep. Two findings:

- **P2 — a canonical match can cross the codec cap (PINNED with an expected-fail test + logged).** A rule
  match is stored as a STRING and parsed TWICE — once at the boundary (`normalizeControlEvent`
  canonicalizes via `print`) and again in the reduce. `print` can EXPAND a value (`1e99`→`1e+99`), so a
  match under the 2048-char cap on input can exceed it once canonicalized: the boundary ACCEPTS the
  event but the reduce throws `EXPRESSION_TOO_LONG`, committing it while skipping its rule (replay
  re-throws). Repro confirmed: input 2008 → canonical 2408 chars. This is PRE-EXISTING (the deleted
  builder stored the same `print(matchPrefix)`); the boundary only extended that canonicalization to raw
  appends. Per the rubric (a bug needing a decision), pinned with `test.fails` in core-processor.test.ts
  and logged here. FIX (a decision for a focused pass): carry the parsed match THROUGH storage so the
  reduce never re-parses — derive the table key with `print` once (printing has no cap). Same shape as
  the target, which is already stored parsed. Keeping the match a readable STRING in the event payload
  (the owner's "see the payload" preference) argues for fixing the reduce side, not the payload shape.
- **P3 — worker tests normalized before reaching the boundary (FIXED).** The DO's `append` and the
  pager-attach path BOTH run `normalizeControlEvent`, so the tests' own `normalizeControlEvent(...)`
  wrappers were redundant AND blind: a test would still pass if the DO's normalization vanished. Stripped
  all 36 wrappers across the 5 workers tests — they now append LITERAL `{ type, payload }` straight at
  the door (the canonicalization assertion now proves the BOUNDARY canonicalizes, appending a
  leading-whitespace match raw). `ruleFor` kept as a raw-literal fixture. The unit/reducer fixtures
  (core-processor, itx-expression-rewriting, subscription-delivery, memory-budget) KEEP the explicit
  normalize — they drive a bare Stream/reduce with no boundary in front.

Gates after both: unit 543 | 6 xfail · workers 77 | 13 xfail | 2 skip · typecheck · oxlint 0/0 · knip clean.

## Round 10 — app-config → the shared zod env parser (one of the logged larger refactors: DONE)

Per the owner's steer ("use app config for all env vars from packages/shared"), `app-config.ts` no
longer hand-rolls a var whitelist + interface + imperative parser (was ~150 lines). It now declares a
zod schema and parses through `@iterate-com/shared/config`'s `parseAppConfigFromEnv` — the same idiom
apps/os, auth and semaphore use.

- **The schema IS the field list.** `AppConfig = z.object({ … })`; the shared parser maps
  `APP_CONFIG_PROJECT_HOSTNAME_BASE` → `projectHostnameBase`, so one declaration replaces the whitelist,
  the interface and the reader. Per-field validation (required, HTTP(S) origin) lives on the fields;
  cross-field rules (a distinct MCP origin; Google id+secret together) and the derived `testEmailLogin`
  stay in `parseAppConfig` (the shared parser needs a plain-object schema).
- **Secrets are `Redacted`** (`redacted(z.string()…)`) — a config object can no longer leak an HMAC key
  or admin bearer to a log. The four consumers call `.exposeSecret()` at the one point of use
  (verifyAdminSecret, signClaims/verifyClaims, ClientSecretPost, signProjectToken).
- **Boot errors still name the variable.** A small wrapper turns the shared parser's ZodError into
  `APP_CONFIG_<VAR>: <message>` (the inverse of the parser's key mapping), so a misconfigured deploy
  still fails loud and named — the property the clean room cared about.
- **Behavior deltas from adopting the shared parser** (both platform-standard): an unknown `APP_CONFIG_*`
  var now WARNS loudly and is ignored (was: refused); a non-string var is ignored → its field reads as
  unset. worker.test.ts's table updated for both, plus `.exposeSecret()` comparison of the secrets.

Gates: unit 543 | 6 xfail · workers 77 | 13 xfail | 2 skip · typecheck · oxlint 0/0. PROVEN on prd
(version a7f67c24): all four deploy smoke checks green, and 38 auth-critical e2e (session, oauth,
rewrite-rules, secrets) pass against the deployed worker — every one authenticates through
`adminApiSecret.exposeSecret()`, and the token-mint path exercises `projectTokenSecret.exposeSecret()`.
The 2 e2e failures are pre-existing/environmental (secrets-egress + context-DNS need PROJECT_HOSTNAME_BASE
injected into the vitest worker thread — a harness gap; session's MCP personal-token 401), all failing
identically before this refactor.

Remaining logged item: library.ts protocol split (a cohesion decision).

## Round 11 — post-refactor cleanup pass (codex xhigh + a fork subagent, both fresh)

A codex full-room review plus an independent fork subagent, both told what already landed. Both agreed
the room is otherwise clean (knip clean; the large files — processor.ts, rpc-stubs.ts, repos.ts,
stream.ts, subscription-delivery.ts — are cohesive with no worthwhile merges; repeated literal event-type
strings are the no-indirection taste, kept). Applied the concrete wins:

- **Reuse the facet-memo writer** (iterate-context-durable-object.ts). The config-refresh loop
  hand-rolled the normalize → compare → persist that `#facetStartupMemoFor` already does; it now calls
  that method, so ONE place writes a facet startup memo (~10 lines gone).
- **Delete the dead reserved-rule try/catch** (`#unsetWhatNamesRpcStub`). It guarded `restoreRuleTarget`
  throwing on a match rooted at `itx.builtins` — but the append boundary now refuses such rows at set
  time, so they can't be in the table, and the async `append()` refusal never reached the sync catch
  anyway. Each removal already catches its own async refusal.
- **Delete dead commit parsing** (context/repos.ts). `parseCommit`/`CommitFields` built `message` and
  `parents` its one caller never read; `tipSnapshot` now reads just the `tree` header inline.
- **Pass the parsed target, not the event** (`#refuseAnOverrideNamingItsOwnContext`). It re-cast the
  event payload to recover the target the caller already had; it now takes `ItxExpression | null`.
- **Inline the single-use pager-refusal response** (context/rpc-stubs.ts), computing `errorCode` once.
- KEPT `loadStartServerEntry` (control-plane.ts): a named, memoized dynamic import reads clearer than a
  `??=` mutation inlined into an `await`, and its comment explains why the import must stay dynamic.

Gates: unit 543 | 6 xfail · workers 77 | 13 xfail | 2 skip · typecheck · oxlint 0/0 · knip clean.

Both reviewers CONFIRMED the two remaining parked bugs are still live (see the parked list below):
idempotency-echo effects (LOW–MED) and library-WebSocket idle cleanup (MED).

## Round 12 — the two confirmed parked bugs fixed (A1, A2), minimal impl

The owner asked to clear the two live bugs both reviewers confirmed, ahead of a merge.

- **A1 — idempotency-echo re-runs the DO commit effects (FIXED).** `#appendAndRunCommittedEffects` ran
  the three effects (facet delete / memo refresh / dead-stub un-set) on `committedEvents`, which
  interleaves idempotency ECHOES (a retry re-answers with the historical event); delivery already used
  `freshEvents`. Configure A → replace with B → retry A could re-refresh A's stale startup memo. Fix
  (minimal, no API change): the DO reads `highestAssignedOffset()` before the append and runs the three
  effects on `committedEvents.filter(e => e.offset > headBeforeCommit)` — fresh commits get NEW offsets,
  echoes keep their historical (<= head) one (stream.test.ts already pins that echo behavior). The
  return value (full committed) is unchanged, so the built-in `append` verb and every caller are
  untouched.
- **A2 — library connections escaped the idle quiesce (FIXED).** `#recordActivityForQuietClock` armed
  the quiesce alarm only for live facets / borrowed stubs, so a connection-only context never armed it
  and pinned the DO awake (billed) — even though library.ts's own header says a held connection "pins
  the context awake exactly like a borrowed stub". Fix: `buildLibrary` exposes `hasOpenConnections()`
  (its live-connection map is the truth); both the arm-eligibility and the alarm's re-arm now count it;
  and `invoke` records activity in a `finally` (the pre-call note ran before the connection existed), so
  a connection-opening call arms the clock. Release stays as-is (fire-and-forget, matching returnBorrowed).

No dedicated tests (minimal, per the owner): A1's echo-offset mechanism is already pinned in
stream.test.ts and the filter is a trivial consequence; A2 needs a live connectable endpoint (an e2e
concern like the WS-relay pin) and a facet-counting unit test would be materialization-timing fragile.
Gates: unit 543 | 6 xfail · workers 77 | 13 xfail | 2 skip · typecheck · oxlint 0/0 · knip clean.

Remaining parked (see the round-11 tail list): A3 double-parse (pinned), A4 WS-relay race (pinned),
A5 dispose-during-pause, the B decisions (token systems, path-mask, MCP lifecycle), C1 library split,
and the D nice-to-haves.

## Round 13 — D5 (prologue trim) + A3 (double-parse match) + D1 research

Working the parked list smallest-first, per the owner's calls.

- **D5 (prologue trim) — near-no-op, done.** The prologues codex flagged as "essays" are actually
  gotcha/wiring content the owner wants (the DO's door/effect map, processor.ts's 5-rule concurrency
  contract + push-delivery semantics, library.ts's layering litmus + memoized-connection rationale).
  The only genuinely-roadmap prose was library.ts's "`connectToGraphql` is the obvious next member …
  does not exist yet" — cut. Everything else kept.
- **A3 (double-parse match crossing the codec cap) — FIXED, `test.fails` flipped to a passing test.**
  A rule match was stored as a STRING and parsed TWICE (boundary `print` canonicalizes, reduce
  re-parses); `print` can expand a value (`1e99`→`1e+99`) past the 2048-char string-codec cap, so the
  boundary accepted an event the reduce then threw on (rule silently skipped). Fix (design-aligned —
  the cap's error already says "pass the parsed form instead", and the TARGET was already stored
  parsed): `normalizeRewriteRuleConfigured` returns the match as the PARSED prefix (not `print`ed), and
  the reduce reads it in place, deriving the table key with `print` (printing has no cap). So a match is
  parsed ONCE, at the door, and a large match passed as an array flows through uncapped — matching the
  target's handling. Payload shape change: `payload.match` is now the parsed array (like `payload.target`
  already was); ~a dozen test assertions updated to the array form. Human string input over 2048 is
  still refused at the door (correct — strings are for what a person types).
- **D1 (OpenAPI `$ref`) — RESEARCHED, awaiting owner's call.** oRPC's OpenAPI lib is the WRONG direction
  (it GENERATES/serves a spec from an oRPC router; it can't parse a foreign spec). The consumed surface
  is tiny — `connectToOpenApi` reads only operationId, param name/in/required, and `hasRequestBody` as a
  BOOLEAN (the request-body schema is never read) — so the only refs that matter are internal (`#/…`)
  parameter refs. Recommendation: a ~20-line internal `$ref` resolver (zero deps, Worker-safe, matches
  the file's small-surface design), reaching for `@scalar/openapi-parser` only if full external/schema
  dereferencing is ever needed. Owner to decide dep vs. hand-roll before implementing.

Gates: unit 544 | 5 xfail · workers 77 | 13 xfail | 2 skip · typecheck · oxlint 0/0 · knip clean.

## Round 14 — A4 (investigated: false positive) + D1 (internal $ref resolver)

- **A4 (WS-relay early-frame race) — NOT A REAL BUG; regression pin added.** A workerd test with a
  provider that GREETS on connect (`GreetingSite` sends its first frame the instant it upgrades, before
  any eyeball frame) receives that frame correctly on the CURRENT code — 5/5 green. `serve()` accepts
  the eyeball SYNCHRONOUSLY the moment `transport.fetch` resolves, which reliably precedes the ASYNC
  frame-delivery event on the leg, so the codex-flagged race does not manifest in workerd. Kept the
  greeting test as a regression pin; did NOT apply the accept-before-dial reorder (a risky change to a
  hibernation relay for a bug that does not reproduce — the owner concurred: keep the pin).
- **D1 (OpenAPI internal `$ref`) — DONE, hand-rolled (owner: "20 lines").** `connectToOpenApi` now
  resolves internal (`#/…`) `$ref` parameters (and path-item refs) with a tiny cycle-guarded resolver
  (`resolveInternalRef` + `derefInternal`), zero deps — oRPC's OpenAPI lib was the wrong direction (it
  generates/serves a spec from a router, can't parse a foreign one), and the consumed surface is only
  param name/in/required (the request-body schema is never read), so a full dereferencer was overkill.
  External refs (URL/file — this lane fetches only the spec), missing internal refs, and malformed
  params still drop. Test updated: an internal ref resolves, an external/missing/malformed one drops.

Gates: unit 544 | 5 xfail · workers (ws-fetch-live-101) 4/4 · typecheck · oxlint 0/0.

## Round 15 — D3 (declarative processor test harness) + the processor TRIPLET convention

- **D3 — a declarative `{ events → state }` processor harness, DONE.** `stream/test-support.ts`
  `reduceProcessor(processor, inputs)` folds inputs through a processor's pure `reduce` exactly as the
  engine does — initial state, per-payload contract validation (a malformed KNOWN payload is skipped),
  reduce, thread the state — the apps/os shape without booting the engine/storage. Table tests added for
  both foundation processors: `account/processor.test.ts` (authentications fold, token create/revoke by
  requestId, malformed-payload skip) and `client/presence/processor.test.ts` (ticks reduced, ephemeral
  pokes never reduced).
- **The processor TRIPLET convention (owner's steer).** Each processor is a FOLDER of three files:
  `contract.ts` (the vocabulary — events, schemas, the view), `processor.ts` (the PURE class — reduce /
  processEvent / projectLiveState, imports only the kernel, so the node lane constructs it with `new`),
  and `durable-object.ts` (the 2–3-line loadable host build-sdk.mjs bundles). Applied to both:
  - `src/account/` → `contract.ts` + `processor.ts` (AccountProcessor, split out of contract.ts) +
    `durable-object.ts` (was account-facet.ts) + `processor.test.ts`.
  - `src/client/presence/` (new folder, was two loose files) → the same four.
  build-sdk.mjs now bundles the `durable-object.ts` of each; the generated source names + the
  PRESENCE/ACCOUNT_PROCESSOR_SOURCE constants are unchanged, so demo/e2e are untouched. knip's explicit
  account build-entry updated to the new path (presence rides the `src/client/**` glob).

Gates: unit 552 | 5 xfail · workers 78 | 13 xfail | 2 skip · typecheck · oxlint 0/0 · knip clean.
