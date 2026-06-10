# itx replaces oRPC: the plan and its decisions

Companion to [the itx spec](./itx-spec.md). The spec defines the capability
layer; this doc records the plan — and the decisions already made — for
retiring the oRPC layer (`apps/os-contract`, `apps/os/src/orpc/`, the
`/api/orpc*` + OpenAPI routes) and serving every consumer through itx.

Work tracking: `tasks/os-orpc-teardown.md` (the cutover) and
`tasks/os-codemode-to-itx-processor.md` (codemode → itx processor).

## The goal

**Reactive views on the front end that connect straight into itx contexts**,
and **one conceptual way to interact with the system: run code against an
itx**.

Most views for domain objects collapse into two components:

1. **A reduced-state view** — reactively renders the reduced state of the
   associated processor.
2. **A filtered stream view** — renders the events relevant to that stream
   nicely, with a raw-mode toggle.

Every interaction surface — CLI, MCP, HTTP — is conceptually one endpoint:
_here is an identifier that defines my itx, here is code to run against it; if
I'm authorized to hold that itx, it just works._ The curlable endpoint is
`run(itx, code)` (`POST /api/itx/run`), not 46 REST routes.

Deleting oRPC is the consequence, not the goal. The itx spec already names
this end state (§6.3: React hooks over itx "are the eventual replacement for
oRPC"). auth and semaphore keep their own oRPC stacks — out of scope.

## Decisions (made, not open)

- **Immediate cutover, no coexistence ceremony.** POC posture: no
  backwards compatibility, no dual stacks, `git revert` is the rollback plan.
- **Migration ≠ re-architecture.** The two canonical reactive components
  apply to domains that are already stream-shaped (agents, activity).
  D1-backed domains (projects, secrets, repos, integrations) move to itx as
  typed built-ins consumed via the thin query bridge — they are NOT
  event-sourced as part of this work. New domains are born stream-shaped.
- **One global-context WebSocket per tab.** Project handles are derived
  in-session via `itx.projects.get()` (narrowing is construction, Law 4) and
  cached per connection epoch; reconnect rebuilds them (Law 1).
- **Never capnweb HTTP-batch.** A batch session is one-directional — the
  client can't pass callbacks or provide capabilities, which kills the whole
  point. Browser = WebSocket always; server = in-process handle.
- **Stream filtering is client-side.** One unfiltered subscription per stream
  path per tab, multiplexed to N views; raw mode is the same data. No
  filter-predicates-as-data in the kernel (composition-as-data died in
  itx-spec §9). Escape hatch for chatty streams: a derived stream
  server-side, not filter params.
- **No runtime validation layer.** TypeScript types are the contract;
  capability-layer schema validation waits for TS-types-as-runtime-validation
  (typebox-style). Front-end forms keep zod for UX validation, living inside
  the form components.
- **Project-level authority, audited.** "Which context your handle points at
  IS the authority." The Project DO's public RPC surface was audited: every
  method is project-scoped; nothing crosses a project boundary. No separate
  admin entrypoint needed; no verb-level permission data.
- **Org-membership project creation.** Users may create projects only in
  organizations they belong to; `ItxProjects.create` must honor org claims
  (today it is admin-only, DECISIONS D7) before the projects UI converts.
- **REST/OpenAPI dies.** `/api/openapi.json` + `/api/docs` go away; the
  curlable replacement is `/api/itx/run`. A plain `/api/health` route
  replaces the `__internal` oRPC procedures.

## Architecture: one handle, four transports

```text
React components ── reactive views (reduced state + streams) ── capnweb WS /api/itx (session cookie)
SSR loaders ─────── in-process handle: resolveItx() inside the OS worker (no HTTP at all)
CLI / curl / MCP ── run code: POST /api/itx/run (or connectItx WS for live sessions)
scripts/agents ──── env.ITERATE (unchanged)
```

### Working backwards from worker.ts

After the cutover, `worker.ts` reads as _"authenticate yourself, then we
either route you straight into itx or we render the TanStack application"_:
infra routes (captun, debug, health) → project-host ingress (incl. `/__itx`)
→ `/api/itx[/:ctx]` connect → the TanStack app. The run-code endpoint becomes
a TanStack API route; the three oRPC route files, the OpenAPI handler, and
the crossws/`NitroWebSocketResponse` upgrade dance all disappear.

### SSR: the in-process handle

TanStack Start loaders run inside the OS worker, so the server render never
opens a socket: `getServerItx(requestContext)` calls `resolveItx` directly
with `accessForPrincipal` applied. Handle construction is in-process (~zero
cost); each built-in call is exactly one Workers RPC to the owning DO — the
same hop today's oRPC routers make. Routes under `$projectSlug` get a
project-narrowed handle in route context. Hold this in review: SSR of a
project page must complete with a handful of DO round trips and no fetch to
our own hostname.

## Status

Done (PR #1423):

- Dead oRPC surface deleted: `ping`, `test.*`, `streams.getState`, the
  `/debug` and `/log-stream` demo pages.
- The browser client library exists at `apps/os/src/itx/react/`:
  `ItxProvider` (one lazy socket per tab, session-cookie auth, reconnect),
  `useItxQuery`/`useItxMutation`/`itxKey`, and the stream-tail layer —
  `ItxStream.subscribe(callback)` in the kernel, a refcounted multiplexer,
  `useStreamEvents`, and `ItxActivityTail` (live `/itx` audit tail on the
  project repl page).
- First route conversion: project streams index reads through the handle.

Happening separately: codemode is deleted and replaced by the **itx
processor** (`events.iterate.com/itx/execution-requested` /
`execution-completed`) — see `tasks/os-codemode-to-itx-processor.md`.

Remaining: see `tasks/os-orpc-teardown.md`.

## Known risks

- **Error opacity**: capnweb flattens server throws to strings. A structured
  `ItxError { code, message }` rehydrated client-side must land before the
  bulk of the UI converts.
- **OAuth redirect-URI derivation** currently uses the incoming request URL;
  over itx the call arrives on a long-lived socket — derive from project/app
  config instead, verify on a preview.
- **Observability**: EvlogHandlerPlugin request logging dies with the oRPC
  handlers; the itx supervisor logs invokes, and `/api/itx` connect needs a
  wide-event log before prod cutover.
- **`run` is powerful**: rate limiting / approval policy is explicitly punted
  to the egress/approval work.
