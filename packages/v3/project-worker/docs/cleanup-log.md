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
