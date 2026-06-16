---
state: todo
priority: high
size: medium
tags: [itx, architecture, reference-implementation]
---

# ITX v2 reference simplification plan

Second-round review of the three green simplification branches converged on the
same target shape. Integrate the cuts manually; the branches overlap in
`itx.ts`, `server.ts`, and `DESIGN.md`, so do not stack patches blindly.

## Constraints

- Keep the `StreamProcessor` approach.
- Keep the public API and current e2e behavior.
- Keep the full local Wrangler harness passing.
- Keep dynamic Durable Object facet isolation by mounted capability path.

## Integration order

1. **Core (`itx.ts`)**
   - Replace `#liveCapabilities + #pathCallCapabilities` with one
     `Map<string, LiveInvoker>`.
   - A `LiveInvoker` owns replay mode: normal object replay vs
     `invokeCapability({ path, args })`.
   - Inject parent traversal as `#parent: ItxContext | null`, not as a
     pseudo-address.
   - Keep `#dial(address)` capability-only.
   - Attach host-owned mount identity before dialing dynamic DO addresses.

2. **Serving edge (`server.ts`)**
   - Delete `ItxRpcTarget extends RpcTarget`.
   - Serve all WebSocket contexts as `pathCallable({ invokeCapability })`.
   - Keep the proxy ignorant of root control names; the context handles
     `["provideCapability"]`, `["invokeCapability"]`, `["revokeCapability"]`,
     and `["describe"]` inside `invokeCapability`.
   - Reserve those root control names so user capabilities cannot shadow them.
   - Keep `pathCallable`; it is the load-bearing Cap'n Web proxy.
   - Keep `runScript` out of the Cap'n Web ITX model; POST remains the script
     execution surface.

3. **Client (`client.ts`)**
   - Keep provide-time SDK normalization.
   - Simplify raw SDK support to one local invoker closure that replays
     `path` against the local object.
   - Do not add a client-side path proxy for ordinary calls; naked Cap'n Web
     path pipelining remains the call path.

4. **Tests and fixtures**
   - Share `dynamicCalc` and `repoCounter` between `runtime-matrix.ts` and
     `harness.ts`.
   - Preserve all current e2e cases, especially raw SDK normalization, live
     offline behavior, worker-to-worker `env.ITX.get()`, and dynamic DO facet
     isolation.

5. **Docs**
   - Rewrite docs after code integration so they describe the final model, not
     the historical merge path.

## Manual merge rules

- Do not take the dial branch's `server.ts` wholesale; it predates the edge
  simplification and can reintroduce `ItxRpcTarget`.
- Do not keep `#pathCallCapabilities`.
- Remove `{ type: "context" }` and `{ type: "code" }` parent pseudo-addresses.
- Keep dynamic DO `mountPath` host-owned/internal; it should not feel like
  provider-facing address vocabulary.
- Do not reintroduce `itxVerbs` or another root-verb object. The only serving
  target the proxy needs is `{ invokeCapability }`.

## Final vocabulary

- Durable state: stream-folded capability rows.
- Live runtime state: retained live invokers.
- Parent topology: host-injected context handles.
- Dial: durable capability address to callable stub.
- Serving edge: `{ invokeCapability }` plus `pathCallable`.
- Client: socket plus provide-time raw SDK normalization.

## Part two: follow-ups after the simplification

Do these one by one after the simplification branch is green. Prefer regression
tests first for anything where production already taught us a failure mode.

### Regression-test first

Done in the reference implementation:

- **Live lifecycle**: regression coverage now proves replacement/revoke do not
  leave stale live invokers callable, and the bridge disposes retained live
  values on replacement/revoke.
- **Dynamic DO source upgrade**: regression coverage now mounts a stateful
  dynamic DO, mutates storage, changes source, and proves the same mounted
  durable capability keeps storage while running the new code.
- **Path validation**: regression coverage now rejects empty paths,
  prototype/RPC-probe segments, and reserved root control paths through both
  `provideCapability` and direct `invokeCapability`.

Backburner:

- **Origin-scoped dynamic workers**: first write a small scenario that makes the
  problem concrete. The likely bug is an inherited dynamic worker receiving an
  ITX handle scoped to the provider context instead of the invoking child
  context. Defer until we pick up richer egress/`super`/origin semantics.

### Double-click separately

- **Read-your-writes**: investigate production's append-then-catch-up model
  before promoting this reference shape. The reference now uses the shared
  StreamProcessor delivered-offset wait instead of a local polling loop.
- **Parent as capability**: explore whether parent traversal is actually just a
  special built-in capability/address behind the scenes, e.g. `parent` or
  `parentItx`, instead of a separate injected `#parent` concept. This might
  simplify the model further or reveal why parent topology must stay host-owned.
- **Processor construction/deps shape**: clean up how host dependencies are
  injected into `ItxProcessor`. The current constructor shape is convenient for
  the reference implementation, but it risks hiding which pieces are kernel
  dependencies, which are host topology, and which are domain-object built-ins.
- **Project egress fetcher POC**: add a real-ish project egress fetch capability
  later. It should prove the important production idea without pulling in all of
  prod egress: `itx.fetch(...)`, shadowability, and eventually `super.fetch`.
- **Shared address vocabulary**: unify capability-address recognition between
  client and kernel. `CAPABILITY_ADDRESS_TYPES` is duplicated, and the current
  accepted set includes loose shapes such as `"rpc"` that the v2 reference
  dialer may not really support.

### Do later / security and production hardening

- **Dial authority split**: provider-supplied addresses must not be able to dial
  trusted namespaces or other projects. Production treats dial as a policy
  surface with allowlists/project scoping.
- **Global access propagation**: inherited `__global__` access must not widen to
  `"all"` inside scripts or dynamic workers. Internal handles need the same
  principal/project reach as the WebSocket edge.
- **Address policy**: decide whether ITX2 keeps trusted/untrusted address
  classes, a single allowlisted dialer, or prod's capability dial policy model.
- **Production auth/JWT/admin-cookie plumbing**: out of scope for this reference
  until the shape is promoted from concept-stage.

### Product gaps to keep explicit but not block on

- `extend`, `super`, and origin propagation are absent. This is the biggest gap
  if ITX2 promises production session/middleware semantics.
- Production defaults are ordinary inherited contexts, not constructor built-ins.
  Consider whether `ProjectDurableObject`/`AgentDurableObject` built-ins should
  eventually become parent contexts too.
- Production egress is richer: shadowable `fetch`, `super.fetch`, bare `fetch`
  inside loaded isolates, and terminal secret substitution.
- Production exposes live disconnected state in `describe()`; ITX2 currently
  only fails at call time after provider disconnect.
- OpenAPI and MCP should remain ordinary loopback capabilities, not target kinds.

### Tests to port or adapt later

- Core unit tests: pure provide does not dial; immediate describe after append;
  malformed events do not wedge replay; inherited revoke refusal; reserved name
  rejection; member stubs survive Cap'n Web argument disposal; live revoke
  releases retained stubs.
- Extend/super e2e: path shadowing, access narrowing, isolated child contexts,
  and middleware/fetch override behavior.
- Egress tests: fetch shadowing, `super.fetch`, secret substitution, and bare
  `fetch` inside loaded isolates.
- Dynamic worker origin tests: inherited source caps should call back into the
  invoking child context.
- Dynamic DO upgrade test: same mounted durable cap should preserve storage
  across source/code changes.
