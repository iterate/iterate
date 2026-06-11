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
- **The browser layer is ONE hook** (itx DECISIONS D21, supersedes the
  earlier "one global-context WebSocket per tab" decision): `useItx(context?)`
  suspends until a per-context module-singleton WebSocket to
  `/api/itx[/<ctx>]` is connected and returns the handle stub. No query
  cache, no reconnect machinery, no multiplexer, no SSR — socket death means
  re-suspend and repaint from the subscription's initial state push (D20).
  Multiple sockets per tab are fine.
- **Never capnweb HTTP-batch.** A batch session is one-directional — the
  client can't pass callbacks or provide capabilities, which kills the whole
  point. Browser = WebSocket always.
- **Stream filtering is client-side.** Views subscribe to the unfiltered
  stream and filter what they render; raw mode is the same data. No
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
React components ── useItx(context) → capnweb WS /api/itx[/<ctx>] (session cookie; never SSRs)
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

### SSR: there is none for itx components

**Superseded** (itx DECISIONS D21). The D19 design — `getServerItx` building
an in-process handle for loaders, `getLoaderItx` isomorphism,
`prefetchItxQuery` seeding the QueryClient — was built, shipped, and then
deleted: itx components never SSR. `useItx` throws on the server (a
forever-suspending `use()` would hold the streaming response open), so itx
views live under `ssr: false` routes or `<ClientOnly>` and paint from their
subscription's initial state push once the socket connects. Routes that need
server-rendered itx data don't exist; if one ever does, that's a new
decision, not a revival of D19.

## Status

Done:

- Dead oRPC surface deleted: `ping`, `test.*`, `streams.getState`, the
  `/debug` and `/log-stream` demo pages (PR #1423).
- The browser layer is `useItx`/`getBrowserItx` (`src/itx/use-itx.ts`,
  DECISIONS D21, PR #1472): per-context singleton sockets, Suspense until
  connected, no SSR. Converted consumers: the streams index + detail trees
  (live via `onStateChange`), the breadcrumb stream navigators
  (fetch-on-popover-open), and `ItxActivityTail` (kernel
  `ItxStream.subscribe` from "start"). The earlier react client library
  (provider, query bridge, stream-tail multiplexer, `useStreamEvents`; PR
  #1423) was superseded and deleted.
- Stream subscriptions carry reduced state (DECISIONS D20, PR #1472):
  `subscribe` batches include `state`, `events: false` is state-only mode,
  every subscription gets an immediate initial push, and
  `ItxStream.onStateChange(cb)` is the reactive sugar the views ride.
- `ItxError { code, message, details? }` (`src/itx/errors.ts`): five codes
  riding capnweb as own enumerable props, duck-typed client detection
  (`getItxErrorCode`/`isItxAccessError`), and `onSendError` tagging every
  other outbound error INTERNAL with its stack — see DECISIONS.md D18.
- SSR/loader prefetch (`getServerItx` + `getLoaderItx` + `prefetchItxQuery`,
  DECISIONS D19, PR #1457) — built, then superseded by D21 and deleted.

Happening separately: codemode is deleted and replaced by the **itx
processor** (`events.iterate.com/itx/script-execution-requested` /
`script-execution-completed`) — see `tasks/os-codemode-to-itx-processor.md`.

Remaining: see `tasks/os-orpc-teardown.md`.

## Known risks

- **OAuth redirect-URI derivation** currently uses the incoming request URL;
  over itx the call arrives on a long-lived socket — derive from project/app
  config instead, verify on a preview.
- **Observability**: EvlogHandlerPlugin request logging dies with the oRPC
  handlers; the itx supervisor logs invokes, and `/api/itx` connect needs a
  wide-event log before prod cutover.
- **`run` is powerful**: rate limiting / approval policy is explicitly punted
  to the egress/approval work.
- **Silent stall after Stream DO eviction**: inbound DO subscriptions are
  runtime-only and not restored on wake, and a dead DO produces no status
  transition on the healthy browser↔worker socket. The one-hook layer
  deliberately has no liveness probe (the multiplexer's was deleted with it,
  D21); the exposure is a live view that quietly stops updating until the
  user refreshes (the tree's per-node refresh button re-subscribes). If this
  bites in practice, the fix belongs server-side (DO restores or closes
  subscriptions on wake), not in another client watchdog.
- **Two live-tail stacks**: `useItx` + kernel `ItxStream.subscribe`
  (ItxActivityTail, the live stream tree) and `ProjectStreamView`'s browser
  SQLite mirror over `/api/project-streams`. The itx stack is the strategic
  one; port `ProjectStreamView` onto an itx subscription and delete the
  second stack as part of the conversion sweep. The repl keeps its own
  isolated socket (`createBrowserReplSession`) by design — it needs
  dispose/reconnect-on-demand, and multiple sockets are fine (D21).
