# itx everywhere: rip out oRPC from apps/os + apps/os-contract

## The goal

What we are actually after is **reactive views on the front end that connect
straight into itx contexts**, and **one conceptual way to interact with the
system: run code against an itx**.

Most views for domain objects collapse into two components:

1. **A reduced-state view** — a front-end component that reactively renders the
   reduced state of the associated processor.
2. **A filtered stream view** — renders the events relevant to that stream
   really nicely, and can be toggled into raw mode.

And every interaction surface — CLI, MCP, HTTP — is conceptually the same
single endpoint: _here is an identifier that defines my itx, here is some code
to run against it; if I'm authorized to hold that itx, it just works._ There
should still be a curlable endpoint, but it's `run(itx, code)`, not 46 REST
routes. `/api/itx/run` already is this; we make it the front door.

**Explicitly out of scope:** re-implementing the runtime safety layer Zod gives
oRPC. We still want validation on front-end forms — those schemas move **into
the form components themselves** for now — but we do **not** bring schemas
into the capability layer yet. We wait (Kenton Varda has designs for
validating against TypeScript types directly, typebox-style; that's the future
we want, not hand-rolled zod parses at every DO method).

Deleting the oRPC layer (`apps/os-contract`, `apps/os/src/orpc/`, the
`/api/orpc*` + OpenAPI routes) is the consequence, not the goal. The itx spec
already names this end state (itx-spec §6.3: React hooks over itx "are the
eventual replacement for oRPC"). auth and semaphore keep their own oRPC
stacks; out of scope.

## What we're deleting (sized)

| Thing                                                | Size                                                                      | Notes                                                                           |
| ---------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `apps/os-contract`                                   | 826 LOC, 46 procedures                                                    | only consumed by apps/os itself                                                 |
| `apps/os/src/orpc/`                                  | ~1,925 LOC (8 routers + handler + middleware)                             |                                                                                 |
| Routes `api.$.ts`, `api.orpc.$.ts`, `api.orpc-ws.ts` | 3 files                                                                   | OpenAPI, RPC, WS handlers                                                       |
| oRPC client plumbing                                 | `src/orpc/client.ts`, `lib/project-route-query.ts` query options          |                                                                                 |
| UI call sites                                        | 15 routes + 1 component, ~38 distinct procedures used                     | TanStack Query via `createTanstackQueryUtils`                                   |
| CLI path                                             | `pnpm cli rpc` via trpc-cli discovery (`/__internal/trpc-cli-procedures`) | shared infra in `packages/shared/src/apps/cli.ts` stays (auth/semaphore use it) |
| e2e client                                           | `e2e/test-support/os-client.ts`                                           | 9 e2e files call oRPC helpers                                                   |

Only 30 of 46 procedures are actually used anywhere. 3 use `eventIterator`
streaming (`streams.streamEvents`, `codemode.streamEvents`,
`test.randomLogStream`) — exactly the ones the reactive stream view replaces.

## What itx already gives us (verified)

- **Browser auth works today**: `/api/itx` accepts user session cookies via
  `resolveRequestAuth` (fetch.ts:129), not just admin bearer. WebSocket
  upgrades carry cookies. The admin-cookie bridge is test-only.
- **Run-code endpoint exists**: `POST /api/itx/run` takes
  `{ context, functionSource, vars }`, runs it in a loader isolate with
  `env.ITERATE`, project egress as global fetch. Curlable today.
- **Access model**: admin → `"all"`, user → their project-id list; narrowing is
  construction; child contexts can't escape (fetch.ts:137-176).
- **Surface**: `caps`, `streams` (append/read/state), `repos`, `workspace`,
  `worker`, `project` (full Project DO stub, D17), `projects`
  (get/list/create/remove), `fetch`, `fork`, `describe`. Typed built-ins;
  `Stubify` + `ProjectCaps` merging for caps.
- **Four execution modes proven in e2e**: Node `connectItx`, browser capnweb,
  `/api/itx/run` loader isolates, worker/facet caps.

## Architecture: one handle, four transports

```text
React components ── reactive views (reduced state + streams) ── capnweb WS /api/itx (session cookie)
SSR loaders ─────── in-process handle: resolveItx() inside the OS worker (no HTTP at all)
CLI / curl / MCP ── run code: POST /api/itx/run (or connectItx WS for live sessions)
scripts/agents ──── env.ITERATE (unchanged)
```

**Anti-decision, recorded:** we never use capnweb's HTTP-batch session mode.
A batch session is one-directional — the client cannot pass callbacks or
provide capabilities into the context, which kills client-provided caps and
subscriptions, the whole point. Browser = WebSocket, always; server = in-process.

### Working backwards from worker.ts

The entry point is the design constraint: after this plan, `worker.ts` should
read as _"authenticate yourself, then we either route you straight into itx or
we render the TanStack application."_ Target shape (today's file minus the
oRPC/API-handler branches, with auth hoisted):

```ts
export default {
  async fetch(request, env, ctx) {
    const config = parseConfig(env);
    return (
      (await infraRoutes(request, env, config)) ??        // captun, debug, /api/health
      withEvlog({ ... }, async ({ log }) => {
        const context = makeRequestContext(...);          // db, config, log, exports
        return (
          (await projectHostIngress(request, context)) ?? // <slug>.iterate.app, incl. /__itx
          (await itxConnect(request, context)) ??         // /api/itx[/:ctx] — credential → handle
          await handler.fetch(request, { context })       // the TanStack app: SSR + API routes
        );
      })
    );
  },
};
```

Notes:

- `itxConnect` is today's `handleItxFetch` — already "authenticate, mint
  handle". It stays the only place credentials become handles (Law 3).
- The curlable run-code endpoint moves to a **TanStack API route**
  (`/api/itx/run` as a Start server route) instead of a worker.ts branch —
  one less thing in the entry file; it builds its handle the same way SSR
  does (in-process, below).
- The three oRPC route files, the OpenAPI handler, and the orpc-ws upgrade
  branch all disappear from the routing story. The `NitroWebSocketResponse`/
  crossws dance in worker.ts:159-161 exists only for oRPC-over-WS and goes
  with them.
- Worth a worker.ts header-comment rewrite as part of Phase 5: "one worker,
  three kinds of traffic: infra, project ingress, the app — and itx is how
  anything programmatic talks to us."

### SSR: the in-process handle (key feature, must be fast)

TanStack Start loaders run **inside the OS worker**, so the server render
never opens a socket and never makes an HTTP hop to itself:

```ts
// in a route loader / server function, during SSR
const itx = await getServerItx(); // principal already on RequestContext;
// handle construction is in-process, ~0 cost
const project = await itx.projects.get(slug); // narrowing = construction, no I/O beyond
// the project lookup it already implies
const state = await project.streams.get("agents/main").getState(); // ONE Workers RPC to the DO
```

Selecting which itx: `getServerItx()` returns the global handle for the
request's principal (same `accessForPrincipal` as connect); routes under
`$projectSlug` get a project-narrowed handle in route context so loaders just
use `context.itx`. No second auth step — the principal was resolved once at
the top of the request.

Hop analysis (must hold in review): handle construction allocates objects,
zero network; every built-in call is exactly one Workers RPC to the owning DO
— the same hop today's oRPC routers make. capnweb serialization is not
involved server-side. **Test case to keep us honest:** SSR of a project
dashboard page (project lookup + reduced state of one processor + streams
list) completes with ≤3 DO round trips and no fetch to our own hostname;
assert via evlog wide-event in a vitest against the dev worker.

---

## Phase 0 — decisions

1. **Authorization granularity — DECIDED, audit done.** Project-level
   authority is the model ("which context your handle points at IS the
   authority"). Audit result: every public RPC method on
   `ProjectDurableObject` is project-scoped — nothing crosses a project
   boundary, and the internal-looking hooks (`afterAppend`,
   `requestStreamSubscription`, re-running `createProject`) grant nothing a
   member can't already do via `itx.streams.append`. Genuinely-admin
   operations (create/remove projects, global handles) are already gated at
   the `projects` built-in and connect time. **No separate admin entrypoint
   needed for the cutover**; moving internal hooks behind `protected` is
   later hygiene. No verb-level permission data (the Law).
2. **Org-membership project creation — DECIDED.** You can create projects only
   in organizations you're in. `ItxProjects.create` honors user principals
   whose org claims allow creation (the `can("create", {orgId})` logic from
   `project-access.ts`). The principal's org claims ride along in the handle's
   runtime state (access today is just project ids).
3. **REST/OpenAPI surface dies.** `/api/openapi.json` + `/api/docs` (Scalar)
   go away. The curlable replacement is `/api/itx/run` (as a TanStack API
   route). Keep a plain `/api/health` route (the `__internal`
   health/publicConfig procedures become ~30-line plain HTTP handlers, since
   the shared internal router is oRPC-based).
4. **No runtime validation layer — confirmed non-goal.** Callers hit typed DO
   methods directly; TypeScript types are the contract. Front-end forms keep
   zod schemas for UX validation, living inside the form components. We
   revisit when TS-types-as-runtime-validation materializes. (os-contract zod
   schemas that double as form schemas move into the components; the rest die.)
5. **Migration ≠ re-architecture — DECIDED.** The two canonical reactive
   components apply to domains that are already stream-shaped (agents,
   codemode, activity). D1-backed domains (projects, secrets, repos,
   integrations) move to itx as typed built-ins consumed via the thin query
   bridge — we do NOT event-source them as part of this work. Trajectory
   recorded: new domains are born stream-shaped; D1 domains migrate to
   processors opportunistically after oRPC is dead.

## Phase 1 — kernel hardening (prereqs, no consumer migration yet)

1. **Reconnecting client.** The spec promises a reconnect loop
   ("provide-on-open"); `connectItx` has none. Build one shared client core
   (browser + Node): exponential backoff, re-auth on reconnect, in-flight call
   rejection with a typed `ItxDisconnected` error. Reactive views sit on this —
   a dropped socket must mean "reconnecting…", not a dead page.
2. **Structured errors.** capnweb currently flattens server throws into opaque
   strings. Introduce `ItxError { code, message, details? }` with codes
   (`NOT_FOUND`, `FORBIDDEN`, `CONFLICT`, `BAD_REQUEST`) serialized across the
   RPC boundary and rehydrated in the client core. UI error states and tests
   depend on this.
3. **Server-side handle.** `getServerItx(context: RequestContext, target?)` →
   in-process `resolveItx` with `accessForPrincipal` applied. Used by SSR
   loaders and any server code that previously used `createRouterClient`.
4. **Browser stream subscriptions — the heart of reactivity.** New built-ins:
   - `itx.streams.get(path).subscribe(callback, { afterOffset? })` — browser
     passes a callback over capnweb (RpcTarget); server wires it to the
     Stream DO's existing `subscribe({ processEventBatch, replayAfterOffset })`
     RPC, which already pushes batches back to a caller-held stub (this is
     exactly how the oRPC `streamEvents` handler works today,
     `orpc/routers/streams.ts:141`). The stateless worker holds both the
     capnweb session and the Workers RPC connection, so this is a bridging
     job, not new machinery. Returns a disposer. Caveat: a worker invocation
     holding a live DO subscription pins the WS (no hibernation until
     capnweb-in-DO lands upstream, Law 7) — acceptable, same cost as today's
     SSE.
   - `…​.subscribeState(callback)` — same, but fires with the processor's
     reduced state on each commit (state view = `getState()` once + deltas).
     This replaces all three `eventIterator` procedures and is what the two
     canonical view components consume.

## Phase 2 — the reactive view layer (`apps/os/src/itx/react/`)

1. **`<ItxProvider>`** — DECIDED: **one global-context WebSocket per tab.**
   Connects once to `/api/itx`; project handles derived in-session via
   `itx.projects.get(slug)` and cached per slug (narrowing is construction,
   Law 4). Reconnect logic lives in one place and rebuilds derived handles
   (Law 1: live refs are runtime-only). Access-list changes (user granted a
   new project mid-session) require a reconnect — acceptable. Connection
   state exposed (`connected | reconnecting | error`).
2. **Subscription multiplexer.** Because everything shares one socket, the
   provider owns a per-tab subscription manager: one server-side subscription
   per stream path, refcounted fan-out to N consuming components, buffered
   replay for late mounters, unsubscribe (with a short linger) when the last
   consumer unmounts, and re-subscribe-from-last-offset on reconnect. Stream
   views are built on this, never on raw `subscribe`.
3. **The two canonical components** (the actual goal):
   - **`<ReducedStateView stream={path} render={...}>`** /
     `useItxState(path)` — reactively renders a processor's reduced state:
     initial `getState()`, then live via `subscribeState`. SSR seeds the
     initial state; the browser takes over live.
   - **`<StreamView stream={path} filter={...}>`** / `useStreamEvents(path)` —
     renders relevant events nicely (per-event-type renderers), with a raw-mode
     toggle showing the unfiltered event JSON. Replay-from-offset + live tail:
     on mount, `read()` the last page of history, then subscribe from that
     offset — no gap. DECIDED: **filtering is client-side** — the multiplexer
     holds one unfiltered subscription per stream; views filter locally, so
     raw mode is the same data and N views share one subscription. No
     filter-predicates-as-data in the kernel API (that's the composition-as-
     data pattern itx killed, spec §9). If a stream gets too chatty, the
     escape hatch is a derived stream server-side, not filter params.
     Most domain-object pages (agents, codemode sessions, project activity)
     become instances of these two.
4. **One-shot reads/mutations.** For the residue that isn't stream-shaped
   (lists, settings forms), a thin TanStack Query bridge:
   `itxQuery(["secrets","list"], (itx) => itx.secrets.list())` and
   `itxMutation(...)` with documented key conventions replacing
   `orpc.x.key()` invalidation. Deliberately small (~150 LOC); the typed
   handle is the contract. Long-term, even these pages drift toward reduced
   state as processors grow.
5. **SSR**: route loaders call `getServerItx` via TanStack Start server
   functions, seed the QueryClient / initial reduced state; browser hydrates
   and re-subscribes.

## Phase 3 — surface parity (close the gap to the 30 used procedures)

Mapping of every used oRPC namespace → itx surface:

| oRPC                                                                    | itx target                                     | Work                                                                                                                                                                          |
| ----------------------------------------------------------------------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `projects.list/find/findBySlug/get`                                     | `itx.projects.list/get` + `describe`           | mostly exists; add slug lookup + pagination metadata for users                                                                                                                |
| `projects.create/remove`                                                | `itx.projects.create/remove`                   | open to org-member users (Phase 0.2)                                                                                                                                          |
| `projects.updateConfig`, `customHostnameStatus`, `ensureCustomHostname` | `itx.project.hostnames` facade                 | new typed built-in calling existing domain code                                                                                                                               |
| `project.lifecycleState`                                                | `itx.project.describe()` / DO stub             | exists via D17                                                                                                                                                                |
| `project.streams.*` (7)                                                 | `itx.streams.*`                                | exists; `subscribe`/`subscribeState` (Phase 1.4) covers `streamEvents` + `getState`                                                                                           |
| `project.secrets.*` (4)                                                 | new `itx.secrets` built-in                     | typed facade over existing secrets domain; redaction logic moves with it                                                                                                      |
| `project.repos.*` (3)                                                   | `itx.repos`                                    | exists (passthrough); verify create/get parity                                                                                                                                |
| `project.codemode.*` (6)                                                | new `itx.codemode` built-in                    | sessions list/create/find, executeScript, describe; events via stream subscribe                                                                                               |
| `project.agents.*` (5)                                                  | new `itx.agents` built-in                      | list, presets, sendMessage; runtime state via reduced-state view                                                                                                              |
| `project.integrations.*` (6)                                            | new `itx.integrations` built-in                | start-flow returns redirect URL (callback routes are already plain HTTP and stay); redirect-URI derivation must come from config, not the request — needs a preview-slot test |
| `project.inboundMcpServer.listSessions`                                 | `itx.mcp.listSessions` or DO stub              | trivial                                                                                                                                                                       |
| `ping`, `test.*`                                                        | delete                                         | `randomLogStream` demo replaced by a `<StreamView>` demo                                                                                                                      |
| `__internal.*`                                                          | plain HTTP `/api/health`, `/api/public-config` | drop trpc-cli discovery                                                                                                                                                       |

Each new built-in is a typed `RpcTarget` class on the handle (like
`ItxStreams`) delegating to the **same domain modules the oRPC routers call
today** — this phase moves wiring, not logic. TypeScript types are the
contract; no boundary schema layer (Phase 0.4).

## Phase 4 — immediate cutover (DECIDED: flag-day, no coexistence)

This is a proof of concept with no customers; we do not want backwards
compatibility, dual stacks, or migration ceremony. One focused push — kernel,
react layer, facades, every consumer converted, and oRPC **deleted in the same
stroke**. Conversion and deletion are not separate phases: a route is done
when its oRPC import is gone, and the push is done when `@orpc/*` doesn't
appear in apps/os's lockfile entry. If state gets awkward mid-cutover, wiping
the dev/preview (even prod) database is on the table.

Everything converts in one branch, ordered only by build-dependency:

1. **Convert all 15 routes + 1 component + 2 lib files** onto the reactive
   views and query bridge. Stream-shaped pages (log-stream, agents streams,
   codemode) go onto `<StreamView>`/`<ReducedStateView>`; D1-backed pages
   onto `itxQuery`/`itxMutation`. No flags, no fallbacks.
2. **e2e test-support**: rewrite `os-client.ts` helpers (`createProject`,
   `readProjectStreamUntil`, `streamProjectEventsUntil`) on `connectItx`;
   migrate the 9 e2e files. The itx e2e suite already proves the transport.
3. **CLI + MCP = run code.** One verb:
   - `pnpm cli itx run <file.ts|-e 'expr'> [--project p] [--vars json]` —
     wraps `POST /api/itx/run`; identical semantics from curl.
   - `pnpm cli itx call <path...> [json-args]` — sugar that compiles to a
     one-line run script (`({itx}) => itx.secrets.list()`).
   - MCP: a `run_itx_code` tool on the project MCP server — same endpoint,
     same authorization (you hold the itx or you don't).
   - Discovery: `itx.describe()` + the typed handle replace trpc-cli
     procedure listing. `packages/shared/src/apps/cli.ts` untouched
     (auth/semaphore still use it).
4. **Delete in the same branch**: `apps/os/src/orpc/`, the three API route
   files, `apps/os-contract`, workspace dep + `@orpc/*` deps,
   `createTanstackQueryUtils` usage, os-contract refs in tsconfig/build, the
   crossws/NitroWebSocketResponse upgrade branch in worker.ts. Add plain
   `/api/health`. Rewrite worker.ts header comment.
5. **Doc sweep**: CLAUDE.md ("Talking to OS"), apps/os/AGENTS.md,
   architecture docs, doppler-backed-scripts — all reference `cli rpc` /
   `/api/orpc`.
6. **Verify**: `pnpm typecheck && lint && test`, full e2e (`e2e:itx` + the 9
   migrated files), preview-slot deploy, click through every dashboard page,
   then prod.

## Risks / open questions

- **Full DO surface for project users (D17)** is the biggest security item:
  before any user-facing migration, audit `ProjectDurableObject`'s public RPC
  methods — anything admin-grade must move off the user-reachable surface
  (Phase 0.1).
- **No runtime input validation** is a deliberate posture, not an oversight —
  but it means a malformed call corrupts state instead of 400ing. Mitigation
  until TS-native validation lands: keep destructive built-ins defensive
  (explicit existence checks, typed ids), and lean on the audit stream.
- **WS connection per tab**: cold connect adds latency to first paint;
  mitigation: SSR-seeded state means no client fetch is needed for first
  paint, the socket warms in the background. (HTTP-batch is NOT a fallback —
  see the anti-decision above.)
- **Error opacity**: ItxError (kernel item 2) is in the morning's work; UI
  conversion assumes it exists.
- **OAuth redirect-URI derivation** currently uses the incoming request URL;
  via itx the call arrives over a WS established earlier — derive from
  project/app config instead. Verify on the preview deploy.
- **Observability**: EvlogHandlerPlugin request logging dies with the
  handlers. The supervisor already logs invokes; add a wide-event log at
  `/api/itx` connect. POC posture — good enough.
- **Rate limiting / abuse**: oRPC had none either, but `run` is a more
  powerful primitive than 46 fixed procedures; note for the egress/approval
  policy work, punt for now.
- **No OpenAPI**: REST paths die with no deprecation; replacement story is
  "curl `/api/itx/run`". POC, no customers — acceptable by decision.

## Sequencing — one-day cutover

One branch, build-dependency order, landed as a single PR (or a same-day
stack if review prefers it):

```text
morning   kernel: subscribe/subscribeState, ItxError, getServerItx, reconnect-lite
          react:  ItxProvider + multiplexer + the two views + query bridge
          parity: secrets/codemode/agents/integrations/hostnames facades (wiring, not logic)
afternoon convert all routes + e2e helpers + CLI/MCP run-code
          delete orpc/, os-contract, deps, routes; doc sweep
evening   typecheck/lint/test, e2e, preview deploy, click-through, prod
```

Risk posture is POC: no rollback plan beyond `git revert`, no dual-stack
window, prod database is expendable if state gets awkward.
