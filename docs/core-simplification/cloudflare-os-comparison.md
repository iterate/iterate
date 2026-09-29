# Cloudflare OS implications for the Iterate core

This is a ranked implementation input, based on the public Cloudflare OS source at `a9adc80` and the runtime review in [`cloudflare-os.md`](../../research_notes/Iterate%20core%20runtime%20review/cloudflare-os.md).

1. **Make a serializable `ContextManifest` authoritative.** It declares each named capability/facet’s kind, code hash and version, compatibility date/flags, class or entrypoint, placement, public surface, and durable-versus-ephemeral status. Generate the `ITX` TypeScript surface, context description, access validation, and loader input from it. Cloudflare OS keeps its portable blueprint definition separate from live credentials/stubs; use the same separation here.

2. **Treat all loaded-worker and ordinary RPC handles as reconstructible implementation state.** A Worker Loader does not guarantee isolate identity, and a live callback/capability needs disposal and reconnect. Resolve a declared capability through a short-lived context-owned resolver; do not put a `Fetcher`, `RpcStub`, `RpcTarget`, secret, or closure in `ITX.Builtins` or durable context state.

3. **Unify subscriptions and live providers behind one pager.** The durable part is `{filter, cursor, policy}`. The transient part is a bounded target/lease. Appending a durable event makes it pageable; a live target gets the low-latency offer and is removed on failure. Re-registration reads from the cursor. Ephemeral events are only offered live and have an explicit dropped/closed result.

4. **Use facets for declared user-space state, not platform choreography.** A context supervisor owns event append/cursors/manifest and starts a named facet using the declaration. Voice agents, application processors, and integrations become facets or loaded workers. A facet owns its isolated state and receives narrow bindings, not the context’s omnibus Builtins object.

5. **Use explicit capability recipes only for durable hooks.** Cloudflare OS’s `ctx.restore()` pattern can recreate a capability from serialized params, but requires `allow_irrevocable_stub_storage` and introduces restore-scoping/proxy machinery. If Iterate needs this, support one versioned, revocable, expiring recipe interface. It must not become the default subscription/session representation.

6. **Keep browser realtime outside long-lived RPC capabilities.** Cloudflare OS issue #338 reports that a returned capability held by a browser pins the workspace DO and drives duration billing. Use a hibernatable server WebSocket with session ID/cursor attachment when idle connection hibernation matters; reconstruct and page from context state.

7. **Delete recovery branches only after preserving the two real failure boundaries.** A DO attempt can fail/leave a broken stub, so operation/event identities must be idempotent and a retry must acquire a fresh stub. A facet/code activation can change or be aborted, so every declared activation needs an observable generation/version. Input/output gates already supply normal storage serialization and should replace broad per-call locks.
