---
state: open
priority: medium
size: large
dependsOn:
  - os-shared-stream-runtime-preview
---

# OS stream runtime big refactors

Bold follow-up refactors from the OS shared stream runtime migration. The
direction is:

1. OS becomes more monolithic and easier to handle.
2. `packages/shared` contains code that is genuinely needed by multiple apps.
3. Server-to-server communication uses Cloudflare RPC and env bindings instead
   of WebSockets, oRPC clients, or public URLs.

## Refactor Candidates

1. Collapse the stream access surface in OS.
   - Current state: OS has direct `env.STREAM` Durable Object calls, a
     `StreamCapability` reached through `ctx.exports`, and public oRPC stream
     routes.
   - Problem: there are three interfaces for the same stream runtime. This
     weakens locality and makes it unclear which interface is authoritative.
   - Proposal: choose one internal interface. Prefer direct env Durable Object
     namespace RPC for app/DO internals, or bind a named `WorkerEntrypoint`
     through env. Delete `workerExports`, `callableEnv`, and
     `getStreamCapability` from ordinary OS app code.
   - Cloudflare references:
     - https://developers.cloudflare.com/workers/runtime-apis/bindings/
     - https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/rpc/
     - https://developers.cloudflare.com/durable-objects/best-practices/create-durable-object-stubs-and-send-requests/

2. Decide whether the Stream Runtime really belongs in `packages/shared`.
   - Current state: `packages/shared/src/streams` owns storage, delivery policy,
     subscriptions, circuit breaker state, debug routes, socket protocol, and
     JSONata behavior.
   - Problem: this may be more product runtime than shared utility. It risks
     turning `packages/shared` into a stream platform package.
   - Proposal: either keep only narrow cross-app stream primitives in shared
     (`Event`, `EventInput`, `StreamPath`, DO-name helpers) and move the runtime
     to OS, or split shared streams into clearly named modules such as runtime,
     storage/sqlite, subscriptions, circuit-breaker, and debug.

3. Make Events an optional stream inspector/client.
   - Current state: Events can bind directly to OS's `StreamDurableObject`
     namespace and exposes public Durable Object debug routes.
   - Problem: OS is supposed to be the simpler monolith, but proof/debug still
     requires another app and another Doppler config.
   - Proposal: move stream inspection/debug routes into OS. If Events remains,
     point it at an OS stream-inspector entrypoint instead of the raw Durable
     Object namespace.

4. Delete `events-contract` stream re-export indirection.
   - Current state: `apps/events-contract/src/index.ts` and sibling files
     re-export shared stream types.
   - Problem: it keeps Events looking like the owner of core stream schemas.
   - Proposal: make `events-contract` expose only the Events app API contract.
     Import stream schemas directly from `@iterate-com/shared/streams/*` in
     apps and UI packages. Delete one-line re-export files.

5. Remove legacy subscription shapes.
   - Current state: shared stream subscriptions still normalize historical
     `callbackUrl` payloads into `Callable` descriptors.
   - Problem: the migration explicitly does not need backwards compatibility.
   - Proposal: make subscription configuration strict: webhook, WebSocket, and
     callable subscribers all carry a `callable` descriptor. Migrate or delete
     old Agents code that still appends `callbackUrl`.

6. Restrict public fetch authority for subscriptions.
   - Current state: webhook and WebSocket paths still use public `fetch`.
     Callable processor subscriptions now dispatch through `CallableContext`
     without adding `globalThis.fetch`.
   - Problem: public URL egress should be an explicit external-subscriber
     authority, not ambient authority for internal processor subscriptions.
   - Proposal: keep `fetch` only in explicit external webhook/WebSocket paths
     and add policy before persisted URL callables can egress from a Stream
     Durable Object.

7. Rename stream event taxonomy away from Events ownership.
   - Current state: core runtime events and Code Mode events use
     `events.iterate.com/...` type names.
   - Problem: stream ownership is no longer Events-app-specific.
   - Proposal: no-compat rename to stream/runtime-owned event type namespaces
     and update Events as a consumer.

8. Tighten or remove the public OS stream oRPC.
   - Current state: OS exposes append/read/get-state by `projectId` and
     `streamPath`.
   - Problem: it is a public HTTP/oRPC interface to project streams. Internal
     server-to-server callers should use env bindings/RPC, not HTTP.
   - Proposal: either delete it, make it explicitly internal/admin-only, or
     authorize it through the same project access path used by Code Mode.

9. Replace persisted loopback callables where env bindings are practical.
   - Current state: Project ingress and MCP routes persist loopback callable
     descriptors that depend on export names and `ctx.exports`.
   - Problem: `ctx.exports` is valid Cloudflare API, but persisted route data
     tied to export names is more implicit than named env capabilities.
   - Proposal: use explicit env/service bindings for platform-owned
     destinations and reserve URL callables for user-provided external targets
     behind policy.

10. Isolate the `ctx.props` mutation bridge for `McpAgent.serve()`.
    - Current state: `project-mcp-server-entrypoint.ts` mutates `ctx.props`
      before handing off to the Agents SDK.
    - Problem: Cloudflare documents `ctx.props` as invocation/config data, not a
      request-local mutable bag.
    - Proposal: isolate this behind a tiny documented SDK bridge helper so it
      does not become a general OS pattern.
    - Cloudflare reference:
      - https://developers.cloudflare.com/workers/runtime-apis/context/#props

## Immediate Cleanup Already Taken

- Removed the one-off Durable Object RPC fast path from stream subscriber
  delivery; callable subscribers now go through shared `dispatchCallable()`.
- Callable processor delivery no longer adds ambient `globalThis.fetch`.
- Restored `resolveBinding()` to own-property lookup so inherited env
  properties cannot be resolved as bindings.
- Fixed SQL generation ownership: Events no longer runs sqlfu in the deleted
  `src/durable-objects` directory, and shared owns stream sqlfu scripts.
- Fixed Agents typecheck fallout from deleting Events `ProjectSlug` exports and
  the old `apps/events/src/lib/project-slug.ts` helper.
