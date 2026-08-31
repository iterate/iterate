# Tightening the core — menu

A 9-agent sweep of `project-worker` (7 subsystem readers + apps/os and capnweb/Kenton comparison
lenses) produced 43 findings across six dimensions — refactor, layering, hard-to-understand,
redundant-comments, vs-Kenton, and apps/os-gap — all weighed against the north star: **a smaller,
tighter core of 3–4 narratively-shaped files, with complexity hidden behind small well-defined APIs**,
so an LLM (or a human, or a 3-video tutorial) can rebuild it from scratch.

**No security findings** — the trusted-client model was assumed throughout. **No bugs** — the
adversarial readers found only simplifications; nothing needed a failing test.

---

## Already done (no action needed — landed, green, live-proven)

Three rounds of net-reduction refactors were executed and committed (full suite 288 passed across 3
lanes; live board green; deploys live-39 → live-41):

- **Round 1** — 15 low-risk items: deleted the `Match.matchedSegments` phantom, collapsed three
  reserved-checks into one `isReserved`, the `resolveFetch` nested ternary, `CORE_SLUG`/`DEFAULT_CTX`
  constants, `attach(stubKey, connectionKey)` (killed false generality), and stripped duplicated
  docstrings (built-ins documented every root twice; the `$7.8k` cacheKey warning was orphaned above
  the imports; a forwarder header described a deleted dependency).
- **Round 2** — two structural extractions out of the 774-line DO: **`core/inline-core.ts`** (the
  checkpoint/replay engine behind an `InlineCore` two-method API) and **`CoreStreamProcessor.admit()`**
  (the pause/breaker admission policy, out of `append()`).
- **Round 3** — **`core/rpc-stub-relay.ts`**: the DON'T-PIN hibernation plumbing (155 lines) lifted
  out of `itx-surface.ts` behind `startRpcStubRelay` + `Parking`; removed removal-log scar comments.

Net effect so far: `stream-durable-object.ts` 774 → ~660 lines; `itx-surface.ts` 282 → 186 lines;
two new small, single-purpose core modules. Also, separately this session: **capnweb bumped to
0.12.0** and **finding #5 (`ScannedRange`)** landed.

---

## THE HEADLINE OPTION — extract the facet host (M1)

> **What:** ~250 lines of the DO are one concern — _materialize a class as a facet of this stream and
> call it_: `#facet`, `#durableFacet`, `#resolveFacet`, `#statefulFacet`, `facetInvoke`, the
> `#resolvedFacetSource` memo, `#driveFacets` (the commit pump), and the `#liveFacets`/quiesce
> interaction. It's interleaved with the stream narrative (commit → pump → deliver), so a reader
> context-switches between "the stream" and "the Worker-Loader glue" on every pass.
>
> **Proposed API:** a `FacetHost` (in `core/facet-host.ts`) constructed with
> `{ ctx, env, address, invoke, entriesForSlug }`, exposing `processor(slug)`, `stateful(ref, name)`,
> `resolve(ref)`, `invoke(ref, path, args)`, `drive(events, after, next)`, and a `quiesce()` hook.
> The DO then reads as **pure stream + capability table**, with all loader complexity hidden.
>
> **LOC:** −230 from the DO. **Risk:** med-high — this is the deepest coupling in the codebase and
> the most defect-prone subsystem (it threads the commit pump, the quiesce alarm, the resurrection
> pass, the table projection, and `/state`). Getting the API boundary right — what belongs to
> `FacetHost` vs stays in the DO (drive? quiesce? `#facetEntries`?) — is a genuine design decision.
>
> **Why it's a menu item, not auto-done:** it's the single biggest narrative win _and_ the one most
> likely to introduce a subtle hibernation/delivery bug if the seam is drawn wrong. It wants your eyes
> on the boundary. **Recommendation:** do it, but as a deliberate joint pass — this is the change that
> takes the DO from ~660 to ~430 and makes it one of the "3–4 core files" you can show an LLM.

After M1, the **"3–4 core files" would be:** `core/processor.ts` (the SDK/runner heart) ·
`stream-durable-object.ts` (the stream: log + sockets + doors + commit→deliver) ·
`capability-table-processor.ts` (the routing table + codec) · `core/itx-surface.ts` (the capnweb
surface). Everything else (`inline-core`, `facet-host`, `rpc-stub-relay`, `worker-loader`, `dispatch`,
`expression`, `event-log`, the forwarder) becomes a small, well-named module hidden behind an API.

---

## Structural consolidations (medium; net reductions)

| #          | Option                                                                                                                                                                                                                                                                                                                                                               | LOC | Risk | Recommendation                                                                                                                                                                   |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- | ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **M3**     | **One facet-host base class.** `ProcessorFacet` and `ProcessorFacetRunner` duplicate the whole spine — `configure()` byte-identical, the same rehydrate-from-identity, four identical pure forwarders. Only `buildProcessor` differs (built-in slug map + parent back-channel vs `user[className]` + `env.ITX`). Extract `abstract FacetHostedProcessor` in `core/`. | −30 | med  | **Do** — but note the runner is bundled into the loaded isolate (build-sdk), so verify the shared base bundles cleanly.                                                          |
| **M8**     | **Single-source the policy schemas.** `DeliveryPolicy`, `ProcessorPolicy`, `SubscriptionLane` are each spelled as a TS type AND inline zod (some twice), while the reduced state stores them untyped (`z.record(unknown)`), forcing `as {…}` casts in `reduce`. Define the zod schemas once in `events.ts`, derive TS via `z.infer`, store parsed shapes typed.      | −6  | med  | **Do** — kills the exact drift class the lane-stamping fix warned about; touches `events.ts` so worth a look.                                                                    |
| **M10**    | **Stop leaking the checkpoint key.** `reduce-checkpoint.ts` exports `reduceCursorKey` _only_ so the facet runner can bypass its own read API to recover the old offset on a version change. Give `readReduceCheckpoint` a discriminated result (`ok` / `version-changed` / `absent`) and delete the export.                                                          | −5  | med  | **Do** — the "one spelling of a checkpoint" module would then actually own its key layout.                                                                                       |
| **M12**    | **Redundant CAS in the forwarder.** `#onDeliveryFailure`'s first act re-reads `#progress` and re-runs the exact freshness check its single caller just ran, with no `await` between — provably dead. Keep one gate.                                                                                                                                                  | −3  | med  | **Your call** — delicate race code you recently fought (`prove_resume_race`); low value, real subtlety.                                                                          |
| **M11**    | **The pump's duck-typed door.** `ProcessorFacet` exposes `pumpSubscriptionDeliveries` and casts `#p()` to an optional method one concrete processor implements — a leak the type system can't see. Model it honestly (folds into M3).                                                                                                                                | 0   | low  | Fold into M3.                                                                                                                                                                    |
| **M6**     | **Per-call `inFlight` counter.** Every invoke ++/-- `retained.inFlight`, whose _sole_ consumer is one warn line at quiesce. Under "delete speculative machinery," drop it (or keep it if the canary has caught a real race).                                                                                                                                         | −8  | low  | **Your call** — the warn may be a genuine hibernation-property canary; I didn't want to delete a tripwire blind.                                                                 |
| **M9/M20** | **Divergent reserved-segment lists.** The client proxy guards 22 names; server `dispatch` guards 3 (`__proto__`/`constructor`/`prototype`). apps/os keeps ONE shared set. Under trusted-client the thin server guard is fine — but a reader can't tell if the asymmetry is intentional.                                                                              | −5  | low  | **Add one clarifying comment** (server intentionally guards only prototype-pollution names because expressions arrive pre-validated), or share one set. Not worth a round alone. |
| **M16**    | **The DO's public RPC surface is broad.** The header says "dispatch is ONE door (`invoke`)," but the class exposes ~14 direct RPC methods, several also reachable via `invoke`→table. A reader can't tell the front door from the plumbing.                                                                                                                          | 0   | low  | **Header note** splitting relay/facet-facing plumbing (`rpcStubActivate`, `deliverToSubscriptionMount`, `armSubscriptionRetry`) from the capability surface.                     |
| **M4**     | **Move the `TallyProcessor` demo** out of the production facet-spine registry into a fixtures module (it's a ~20-line demo, load-bearing only as a test fixture).                                                                                                                                                                                                    | −20 | low  | **Your call** — several tests + a proof import it; a mechanical move, but verify the imports.                                                                                    |

---

## apps/os capability gaps — the MCP-server chapter of your tutorial

These are **feature additions**, not reductions, so they're menu by rule — but they're exactly what
the outline's _"anything speaking capnweb is a tool for a coding agent"_ level needs.

- **M27 — capability discovery (`describe()` / `list()`).** apps/os treats discovery as part of the
  itx contract: every node answers `__describe()` → `{ instructions, types, children, capabilities }`.
  The clean room exposes none — no way to ask "what's mounted here." The capability table _already_
  reduces `state.mounts` (path + target + offset), so the cheap 80% is a **~15-line `Itx.describe()`**
  returning `{ builtins: string[], mounts: {path,target,offset}[] }` — no new storage. **This is the
  prerequisite for the MCP tutorial level and nearly free. Recommended as the next feature.**
- **M28 — `provide()` metadata.** A mount carries no `instructions`/`types`, so even with discovery
  every capability is a bare path an agent can't learn to call. Add optional `instructions?`/`types?`
  to the provide input + the mount event, echo from `describe()`. Pure plumbing (~25 lines). The
  connect-time auto-typing from MCP/OpenAPI schemas (apps/os's ~600-LOC `capability-type-declarations`)
  is a _later_ level — do NOT port it into the core.
- **M17 — MCP/OpenAPI ingress.** apps/os can dial an arbitrary MCP server (with OAuth) or an OpenAPI
  service and surface it as a typed itx capability. The clean room only dials other _capnweb_
  endpoints (`connectToCapnweb`). A conscious deferral — when it lands it belongs behind a small
  `connectToMcp(url)` built-in mirroring `connectToCapnweb`, never inline in the surface.

---

## capnweb / Kenton — fork hygiene + confirmations

- **M23 — drop the unused `onCall` fork patch.** The `@iterate-com/capnweb` fork = upstream 0.12 + two
  patches: the WebSocket-over-RPC upgrade (load-bearing — `fetchCap` depends on it, genuinely not
  upstream) and a server-side `onCall` per-call hook with **zero consumers** in the clean room. Dropping
  it narrows the fork's divergence to a single defensible patch. **Fork-maintenance call** (separate repo).
- **Verified correct — no action** (the sweep closed these hypotheses):
  - `InvokeHandle` (workerd#6873) and the `RetainedCallbackInvoker` shared-`#broken` dance (capnweb has
    no `offRpcBroken`, still true in 0.12) are **still required**.
  - `event_chunks` is a **SQLite cell-size limit** (~2 MB TEXT cap), not capnweb serialization — 0.12's
    exact typed-array encoding does not remove it.
  - `connectToCapnweb` (no-await native pipelining, workerd/capnweb#26) and `walkSteps`
    (`Reflect.apply` not `stub[m].apply`, the DataCloneError learning) are **correct idioms**, not
    reimplementations.
  - Our `Expression` + `InvokeHandle` is **strictly more capable** than apps/os's flat
    `call({path,args})` — do NOT regress toward `replayPathCall`.

---

## Small nits (optional)

- **M15** — `InvokeHandle` folds `(path,args)` → an expression, then unfolds it back to `(path,args)`
  for `#dispatch`. Correct and well-documented; a fold/unfold round-trip that exists only because the
  hop contract is `invokeCapability(ItxExpression)`. Harmless; noted so the seam is understood.
- **M14** — `dotted-path-proxy.ts` is comment-healthy; essentially nothing redundant to delete.

---

## Suggested order

1. **M27 + M28** (discovery + metadata) — small, high-leverage, unlocks the MCP tutorial level.
2. **M1** (FacetHost) — the marquee structural win; do it as a joint pass on the API boundary.
3. **M3, M8, M10** — the medium consolidations, once M1 settles the facet shape.
4. The nits/comments (M9/M20, M16, M6, M12) as a mop-up round.
5. **M23** — fork hygiene, whenever the capnweb fork is next touched.
