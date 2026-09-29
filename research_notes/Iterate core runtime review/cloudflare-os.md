# Cloudflare OS architecture comparison

Research status: reviewed 2026-09-29 against public Cloudflare OS `main` at `a9adc80d7a72548572118519f2f421a4559abec5` (the checkout is at `/Users/jonastemplestein/src/github.com/cloudflare/os`). This is a useful current reference implementation, not a stable platform specification: its README calls v2 early access and heavy development. “Source observation” below means the current public source; “issue report” is deliberately weaker than a Workers contract.

## What Cloudflare OS actually models as a durable context, and which parts transfer to Iterate?

### Takeaway

Cloudflare OS’s strongest transferable idea is a narrow durable supervisor: one workspace Durable Object owns durable metadata, code identity, policy, and lifecycle; each untrusted application runs as a named Dynamic Worker facet with isolated storage. Its source does **not** support turning the whole system into a generic long-lived capability graph: code/session identity is explicit and durable, whereas loaded isolates and normal RPC references are treated as disposable.

### Cited Findings

- **Documented project architecture:** Cloudflare OS describes every workspace as a Durable Object, every Gadget as a Dynamic Worker Facet, and Gatekeepers as facets installed into the workspace. It identifies the workspace’s facet as the sandbox boundary and the supervisor as the controller of access. [Cloudflare OS README](https://github.com/cloudflare/cloudflare-os/blob/a9adc80d7a72548572118519f2f421a4559abec5/README.md)
- **Source observation:** `OverseerImpl.loadGadgetWorker()` uses a loader key derived from context DO id, code version, and gadget id; its callback reconstructs source files and supplies a deliberately narrow `env`, `globalOutbound: null`, a compatibility date, and a tail. The loader key changes when the committed/proposed code changes. [Overseer loader implementation](https://github.com/cloudflare/cloudflare-os/blob/a9adc80d7a72548572118519f2f421a4559abec5/packages/workshop-backend/src/overseer.ts)
- **Source observation:** `getGadgetFacetRaw()` maps one durable name to one facet and starts it with the Dynamic Worker’s `Gadget` class. It uses `ctx.facets.abort()` to switch code revisions, then `ctx.facets.get()` to reconstruct the selected class. [Overseer facet activation](https://github.com/cloudflare/cloudflare-os/blob/a9adc80d7a72548572118519f2f421a4559abec5/packages/workshop-backend/src/overseer.ts)
- **Source observation:** the same file explicitly says that an absent in-memory map entry after the supervisor hibernates is ambiguous, defensively aborts the facet, and notes that “if/when” Overseer hibernation is supported it needs a more sophisticated design. This is evidence that OS has not solved general supervisor/facet live-state reconstruction. [Overseer facet lifecycle comment](https://github.com/cloudflare/cloudflare-os/blob/a9adc80d7a72548572118519f2f421a4559abec5/packages/workshop-backend/src/overseer.ts)
- **Documented project architecture:** blueprints persist source snapshots, binding requirements, and metadata, explicitly excluding SQLite contents, live connections, and credentials. This cleanly distinguishes a portable declarative description from runtime state/capabilities. [Blueprint documentation](https://github.com/cloudflare/cloudflare-os/blob/a9adc80d7a72548572118519f2f421a4559abec5/docs/blueprints.md)
- **Source observation:** `getEnvForLoader()` makes a flat dynamic-worker environment from stable binding names and service-entrypoint loopbacks. The loopback resolves the target session per call; it is used because the source says a Dynamic Worker env can contain ServiceStubs but cannot contain RpcStubs. [Binding environment and loopback](https://github.com/cloudflare/cloudflare-os/blob/a9adc80d7a72548572118519f2f421a4559abec5/packages/workshop-backend/src/overseer.ts)
- **Source observation:** OS keeps public interfaces as explicit TypeScript `RpcTarget` contracts in `workshop-shared/api.ts`; its agent-facing documentation tells agents to request `describeBinding` rather than enumerate a remote object, because an RPC object’s API cannot be discovered reliably at runtime. [Shared API](https://github.com/cloudflare/cloudflare-os/blob/a9adc80d7a72548572118519f2f421a4559abec5/packages/workshop-shared/src/api.ts) and [agent binding instructions](https://github.com/cloudflare/cloudflare-os/blob/a9adc80d7a72548572118519f2f421a4559abec5/packages/workshop-backend/src/agent.ts)
- **Source observation:** OS’s dynamic code currently has a hard-coded `compatibilityDate: "2026-02-01"`, while its deployable backend declares `2026-09-04` plus `allow_irrevocable_stub_storage`. Thus dynamic-code compatibility must be an explicit portion of a declaration and is a real source of drift if not centralized. [Dynamic worker construction](https://github.com/cloudflare/cloudflare-os/blob/a9adc80d7a72548572118519f2f421a4559abec5/packages/workshop-backend/src/overseer.ts) and [backend Wrangler configuration](https://github.com/cloudflare/cloudflare-os/blob/a9adc80d7a72548572118519f2f421a4559abec5/packages/workshop-backend/wrangler.jsonc)

### Inferences

- Adopt the supervisor/facet split, but make it smaller than OS: an Iterate context owns `manifest`, append log/cursors, and lifecycle; a declared facet/worker owns user projection or external process state. The only identity passed across a restart is `{context, name, code/version, capability schema}`.
- `ITX.Builtins` should become an interpreter over a serializable `ContextManifest`, not an accumulating bag of privileged live objects. One catalogue can generate the public TypeScript API, route/public-method policy, loader declaration, human description, and narrow capability bindings. OS’s blueprint split is a direct precedent: source/requirements are durable; credentials/connections/stubs are not.
- Reuse a **single** context-owned binding resolver: a stable declaration name maps to a short-lived service/DO loopback which resolves a permitted live session only for the call. This is clearer and safer than persisting `RpcStub`s in Builtins, and prevents a loaded worker’s isolate identity from entering the API contract.
- Do not copy OS’s hard-coded dynamic compatibility date or broad `any` environment. Put `compatibilityDate`, flags, source hash, class/entrypoint and allowed manifest capabilities in one validated declaration. The host, not the user worker, constructs actual bindings.

### Gaps

- I found no public Cloudflare OS “Iterate context” abstraction, event-log primitive, or universal ephemeral-event model. It is a workspace/productivity platform, so its chat/action persistence cannot establish required semantics for Iterate’s event stream.
- OS’s source comments identify hibernation gaps but do not quantify expected restart behavior, recovery cost, or latency. Treat it as a warning against copying its live maps, not evidence for a particular recovery algorithm.

## What does Cloudflare OS prove about subscriptions, low latency, hibernation, and persistent capabilities?

### Takeaway

OS distinguishes two different cases that Iterate should keep separate: live UI subscriptions are duplicate-able RPC callbacks with disposal/broken-connection cleanup and resubscription; durable hooks use an opt-in restored-stub recipe. The latter permits a durable _way to mint a future capability_, not a hibernatable Cap’n Web session. Cloudflare OS’s own open issue documents that its long-lived returned capabilities keep the workspace DO resident and billable.

### Cited Findings

- **Source observation:** OS asks live subscription callers to `dup()` the callback, register `onRpcBroken()`, remove the callback on disconnection, and have the client’s disposer resubscribe. It says the top-level gadget stub survives backend reconnect but other capabilities in either direction are disposed and must be reacquired. [Gadget subscription guidance](https://github.com/cloudflare/cloudflare-os/blob/a9adc80d7a72548572118519f2f421a4559abec5/packages/workshop-backend/src/agent.ts)
- **Source observation:** `subscribeToMetadata`, `subscribeToChat`, and user connected-account subscriptions all duplicate the callback, subscribe it to local state changes, and return a lease stub whose disposer unregisters and disposes the callback. This is a repeated implementation pattern, not a generalized primitive. [Metadata subscription](https://github.com/cloudflare/cloudflare-os/blob/a9adc80d7a72548572118519f2f421a4559abec5/packages/workshop-backend/src/overseer.ts), [chat subscription](https://github.com/cloudflare/cloudflare-os/blob/a9adc80d7a72548572118519f2f421a4559abec5/packages/workshop-backend/src/overseer.ts), and [account subscription](https://github.com/cloudflare/cloudflare-os/blob/a9adc80d7a72548572118519f2f421a4559abec5/packages/workshop-backend/src/user.ts)
- **Source observation:** chat subscriptions send a server-instance generation before catch-up, replay stored messages/metadata after a cursor, and disconnect the subscriber on callback failure. This is a concrete “durable cursor plus live push” pattern. [Chat subscription implementation](https://github.com/cloudflare/cloudflare-os/blob/a9adc80d7a72548572118519f2f421a4559abec5/packages/workshop-backend/src/overseer.ts)
- **Source observation:** OS documents `ctx.restore(params)` and symbol `[restore]` as a persistent-stub facility: serializable parameters are replayed to create a replacement RPC object for distant-future hooks. The Dynamic Worker is granted `allow_irrevocable_stub_storage` to use it. [Persistent stub guidance](https://github.com/cloudflare/cloudflare-os/blob/a9adc80d7a72548572118519f2f421a4559abec5/packages/workshop-backend/src/agent.ts) and [dynamic-worker flags](https://github.com/cloudflare/cloudflare-os/blob/a9adc80d7a72548572118519f2f421a4559abec5/packages/workshop-backend/src/overseer.ts)
- **Source observation:** because a facet’s `ctx.restore()` is scoped to a parent-created restored stub, OS routes all gadget-facing facet stubs through an Overseer `[restore]` and contains an explicitly labelled “wacky hack” for forging a restorable gadget callback on behalf of an agent. [Restore routing and forger](https://github.com/cloudflare/cloudflare-os/blob/a9adc80d7a72548572118519f2f421a4559abec5/packages/workshop-backend/src/overseer.ts)
- **Issue report with production measurements:** open Cloudflare OS #338 states that `OverseerDurableObject.open()` returns a capability whose session stays in flight while a browser holds it, keeping the DO billable. The report proposes hibernatable WebSockets or short-lived RPC/session identifiers as alternatives and cites a controlled cancellation trace. [Cloudflare OS issue #338](https://github.com/cloudflare/cloudflare-os/issues/338)
- **Documented Workers contract:** DO hibernation discards in-memory state; it cannot happen with standard WebSockets or in-flight events; server hibernatable WebSockets are the supported way to keep clients connected through hibernation. [Durable Object lifecycle](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/) and [WebSocket hibernation API](https://developers.cloudflare.com/durable-objects/api/state/)
- **Issue report corroborated by source:** open workerd #6087 says generic hibernatable `RpcTarget`s are not available. Current workerd source separately rejects generic RpcStub deserialization/persistence, so the OS restore facility should not be generalized to arbitrary live references without a targeted production test. [workerd #6087](https://github.com/cloudflare/workerd/issues/6087) and [workerd `io-channels.c++`](https://github.com/cloudflare/workerd/blob/main/src/workerd/io/io-channels.c++)
- **Commit-history evidence:** Cloudflare OS commit `8dde840` (“Make spawned agents persistent across restarts”) added a large restore/persistence design and tests, indicating this is nontrivial product machinery rather than zero-cost runtime magic. [Commit `8dde840`](https://github.com/cloudflare/cloudflare-os/commit/8dde840)

### Inferences

- Implement one subscription primitive, not one per consumer: `{filter, durable cursor, live target?}` plus a bounded pager. `append` writes first, then offers ordered batches to a live target; a broken target removes only the target. Re-registration performs durable catch-up. This captures OS’s useful cursor/generation/reconnect behavior while avoiding its repeated per-feature lease code.
- Reserve restored stubs for genuinely durable, operator-approved hook callbacks whose restore parameters are a narrow, versioned recipe and whose revocation/expiry is explicit. Do not use them for ordinary event subscriptions or browser sessions: they add a hidden control path and do not solve billable/hibernation residency.
- A live provider callback and subscriber callback can share the same pager target/lease implementation. Both are transient delivery accelerators. The durable contract is append offset + declaration, and the persistent callback facility, if adopted at all, is an optional provider implementation behind that declaration.
- Keep browser/WebSocket protocol state outside the capability graph. A hibernatable WebSocket attachment should identify a session and cursor; context construction restores state and pages events. That directly addresses the failure OS #338 reports for long-lived returned capabilities.

### Gaps

- The public source does not establish whether OS’s `allow_irrevocable_stub_storage` is available, stable, or desired in Iterate’s exact deployed compatibility/runtime combination. It is a feature flag with significant authority/lifetime consequences and must be verified in production before inclusion.
- OS has no public benchmark showing that callback subscriptions meet Iterate’s latency/throughput goal. Its code informs correctness/lifetime design, not a performance claim.

## Which Cloudflare OS patterns should Iterate adopt, adapt, or deliberately avoid?

### Takeaway

Adopt its declaration-before-activation and narrow resolver ideas. Adapt subscriptions into one cursor/pager mechanism. Avoid copying the accumulated restore/proxy/loopback workarounds as the central Iterate model: Cloudflare OS itself shows that this complexity follows from presenting every live capability as a durable/public surface. A much smaller core can make runtime handles private implementation details.

### Cited Findings

- **Source observation:** OS explicitly wraps a Dynamic Worker entrypoint in `Proxy` because dynamic entrypoint/facet stubs cannot directly cross the relevant RPC boundary. The source calls this a hack and contains comments about native RPC type bugs. [Hook entrypoint proxy](https://github.com/cloudflare/cloudflare-os/blob/a9adc80d7a72548572118519f2f421a4559abec5/packages/workshop-backend/src/overseer.ts) and [subscription lease type workaround](https://github.com/cloudflare/cloudflare-os/blob/a9adc80d7a72548572118519f2f421a4559abec5/packages/workshop-backend/src/overseer.ts)
- **Historical issue, corrected:** workerd #3184 reported a JavaScript Proxy
  `DataCloneError`, but workerd #3212 fixed it in 2024. Proxying still does
  not provide universal reflection, description or authority policy, so it is
  not a core capability-model mechanism. [workerd #3184](https://github.com/cloudflare/workerd/issues/3184)
- **Source observation:** OS’s `GatekeeperLoopback` resolves every dynamic-worker binding to a session with caller props on each call; a worktree loopback additionally carries a per-execution ID and deliberately fails if retained after the execution. [Loopback capability narrowing](https://github.com/cloudflare/cloudflare-os/blob/a9adc80d7a72548572118519f2f421a4559abec5/packages/workshop-backend/src/overseer.ts)
- **Source observation:** its sharing/observer design treats stale external setup as recoverable by re-verifying at every open and makes revocation checks authoritative at use time. [Observer design](https://github.com/cloudflare/cloudflare-os/blob/a9adc80d7a72548572118519f2f421a4559abec5/docs/observers.md)
- **Documented Workers contract:** a Worker Loader cache has no same-isolate guarantee, even for the same `WorkerStub`; loader code callbacks can run again, and changed code must use a new ID. [Worker Loader API](https://developers.cloudflare.com/dynamic-workers/api-reference/)

### Inferences

- **Adopt first:** `ContextManifest` as the one durable source for name → kind → code hash/version → compatibility date → class/entrypoint → allowed operations → placement. At activation, validate it, load code, and obtain the facet. At description/type generation, consume this same object. This answers the Builtins visibility/type problem without runtime reflection.
- **Adopt second:** stable named service/DO loopbacks for externally supplied capabilities, with caller/context/epoch props. The resolver must re-check capability declaration and revocation on each call or at a bounded session boundary. It makes fetched-in/fetched-out capability paths explicit and testable.
- **Adapt:** OS’s snapshot-then-subscribe/catch-up sequence becomes one reusable event pager with offsets and an incarnation/generation marker. An ephemeral event can travel only over the live offer path; a durable event is always pageable from the log. This eliminates dual delivery stacks.
- **Avoid:** exposing `ITX.Builtins` as a generic remote object whose members are live stub/proxy chains. Publish typed declared capabilities; create concrete bindings in the resolver; dispose at the request/lease boundary. This removes much of the restore-forger/proxy typing/placement machinery before it exists.
- **Avoid:** persistent-stub storage for Iterate user-space code. The
  `allow_irrevocable_stub_storage` flag is labelled inherently insecure by
  workerd and planned for retraction; it is not a viable default or a
  prerequisite for this core. The OS source demonstrates both the narrow
  restoration use case and the complexity it introduces.

### Gaps

- This comparison did not execute Cloudflare OS or run its Worker integration tests. The report is source/history/documentation research, not a functional endorsement of the current public implementation.
- Cloudflare OS changes rapidly and has no stated semver API for its internal Overseer/restore mechanisms. Pin exact source/Workers compatibility dates if any implementation pattern is borrowed.
