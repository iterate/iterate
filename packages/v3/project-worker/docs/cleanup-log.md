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
