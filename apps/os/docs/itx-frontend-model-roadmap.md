# itx frontend programming model — roadmap

The end-state for apps/os's React/TanStack Start frontend, and the path there.
PR #2048 (one WebSocket per tab) is step one. This doc captures the _further_
refactors, reviewed by two survey subagents + codex (gpt-5.6-sol, max reasoning).

## The model we're converging on

> A single simple programming model: a capnweb capability tree over ONE WebSocket,
> a small number of React hooks/providers stacked thinly on a _very_ narrow core,
> and Elixir-LiveView/Phoenix-style live updates of state in (mostly) Durable
> Object isolates.

The governing rule (the useful LiveView analogy — the server owns durable reduced
views; React renders + owns local interaction):

- **Immutable / historical / versioned / paged / expensive** reads → a finite read
  (`useItxQuery` today; `useRead({ from })` eventually).
- **Mutable current server state** → a live projection pushed from the owning DO
  (`useLiveState` today; `useLive()` eventually).
- **Mutations** → direct capability calls; their result arrives back through the
  live projection — no caller-level invalidation.
- **Ephemeral interaction state** (draft forms, open panels, URL state, optimistic
  pending markers) → stays in React.

The end-state hook set is four thin hooks over a framework-free client:
`useSession()` / `useItx(slug)` (capabilities + actions), `useRead()` (finite
cached reads), `useLive()` (server-owned live projections) — plus the imperative
`connectSession()` / `connectItx(slug)`. Everything else (generations, liveness,
verification, stores, subscription recovery, query scoping) becomes an
implementation detail of the narrow core.

## Where we already are (verified survey)

The frontend is **~95% converged** already: no second socket, no `EventSource`,
no oRPC client, no `useEffect`+`setState` fetch loops for server data. The five
`createServerFn`s are all SSR/auth boundaries (run in `beforeLoad` before the
client socket exists) and correctly stay server-side; the only two `fetch()`es
set a cookie / hit external `$schema` hosts; the only `refetchInterval`/
`setInterval` poll client-side stores / a UI clock. There is no "gunk pile" — the
remaining work is _completing_ the model, not undoing a parallel one.

## Done in PR #2048

- **One WebSocket per tab** — Session gate + slug-addressed `useItx` + invisible
  reconnect (DECISIONS.md D24).
- **`useSessionQuery`** — the session-scoped sibling of `useItxQuery` (same
  transport-only retry, non-suspending for the always-mounted shell). Folds the
  4 hand-rolled `session.projects.list()` reads (sidebar, /projects, ⌘K picker,
  admin) onto one primitive and shrinks `lib/projects-query.ts` to a shared key.
  _(Interim: codex wants this unified into `useRead({ from })` — see below.)_
- Numbered the one-socket decision `D24` (it had collided with existing headings).

## No-brainers (next, small + safe)

- **Honest capnweb handle types.** Replace `type SessionStub = RpcStub<Session>` +
  the `as unknown as` casts with types derived from the real RPC return chain, as
  the mobile client already does (`apps/mobile/src/lib/itx-core.ts:16`):
  ```ts
  type SessionStub = Awaited<ReturnType<RpcStub<UnauthenticatedOs>["authenticate"]>>;
  type ProjectStub = Awaited<ReturnType<SessionStub["projects"]["get"]>>;
  ```
  Add compile-time contract tests (authenticate → SessionHandle, projects.get →
  ProjectHandle, nested calls callable, no public boundary needs a cast). Local
  correction is a no-brainer; making the _generator_ emit distinct client handle
  types (value DTOs vs returned capabilities) is a MEDIUM follow-up.
- **`useProjectLiveState`** — hoist the `(itx) => itx.liveState` accessor repeated
  ~10× (`useLiveState((itx) => itx.liveState, sel, deps, opts)` →
  `useProjectLiveState(sel, deps, opts)`). Keep `useLiveState` for the non-root
  nodes (`itx.liveDemo.ticker`, `secrets.get(p).liveState`, …).
- **Doc cleanup** — `itx/README.md` and `DECISIONS.md` still reference the deleted
  `types.ts` and pre-migration files; replace README with the current browser
  model and move historical material aside.

## Medium

- **Unify the read layer into one scope-aware `useRead({ from, key, read })`**
  (codex #1) with central key factories that mechanically namespace by
  `authorityEpoch` + (for project reads) slug — closing the D24 footgun that
  cache correctness depends on every caller remembering the project in its key.
  `useSessionQuery`/`useItxQuery` become migration aliases. Advance
  `authorityEpoch` only on an authentication/authority reset, never on an ordinary
  transport generation.
- **Collapse the subscription surface** (codex #3, survey): keep `useRead()` +
  `useLive()` + direct capability actions as the public set; move
  `useItxSubscription` to a low-level escape hatch (its only genuine consumers are
  the activity tail + the reactivity test-stream) and keep `useItxEffect` private
  inside the live-resource engine.
- **Make `<ItxProvider>` a real authority boundary** (codex #7, survey M1) — one
  SSR-safe mount near the authenticated root that owns the client lifetime and
  resets resources on authority change. Today it only renders an invisible
  Suspense sibling; if it stays module-global, rename it `ItxPreconnect` (a fake
  provider is misleading). Fold the `Suspense`+`ItxProvider`+`ProjectScope` trio
  and the 14× per-page `<ItxBoundary>` triple into one route convention.
- **integrations + scheduler → live state** (survey M2, codex #2 first target) —
  the two remaining read-then-invalidate lists. `integrations.list` is invalidated
  **5×** (per connect/disconnect) and `scheduler.list` **3×**; exposing them as
  `liveState` slices deletes 8 `invalidateQueries` calls and 2 reads and lets the
  server drive the UI. Needs server-side projection work.
- **Draw a hard server-function boundary** (codex #9): server fns do request-native
  SSR orchestration (auth snapshot, cookies, redirects, redacted bootstrap
  config); product reads/mutations travel the capability tree. Remove
  `getProjectBySlugServerFn` + the broad `context.project` route object once
  project identity is a small live projection (routes carry the slug, mount
  `ProjectScope`, and the capability returns denied/not-found).

## Large (need design)

- **Extract a non-React `BrowserItxClient` core** (codex #6) behind a tiny
  interface (`getSnapshot`/`subscribe`/`connectSession`/`connectProject`/
  `resetAuthority`/`reportTransportSuspicion`), split into e.g. `itx/socket.ts`
  (transport, generations, verification), `itx/live-resource.ts` (shared stores,
  subscription/revision recovery, watchdogs), `itx/read.ts` (scoped keys + TanStack
  adapter), and `itx-react.tsx` (contexts + the four thin hooks). Move
  behavior-preservingly, keep the generation/disposal tests, don't combine with a
  reconnect rewrite. Makes the "very narrow core" literally a testable non-React
  unit with injected sockets/timers/failures.
- **Mutable current state live by default** (codex #2): capability-aligned
  `.liveState` projections — `session.projects.liveState`, `project.streams/
agents/repos/integrations/scheduler.liveState`, per-resource `secrets.get(n)/
repos.get(p)/agents.get(id).liveState`. Root `ProjectLiveState` stays a small
  shell/lifecycle summary, not a dumping ground. Each projection is a load-bearing
  materialized view — its init/persist/rebuild/external-ingest/cold-DO behavior
  must be explicit + tested (esp. the project catalog needs a truthful event source
  for access changes made by _other_ sessions/operators).
- **Replace the browser stream mirror** with bounded server live views + cursor-
  paged history, then retire the browser-hosted stream database/processor host.

## Ordered roadmap

1. **Immediate no-brainers** — honest handle types, `useProjectLiveState`, doc
   cleanup, canonical scoped read keys. _(`useSessionQuery` landed in #2048.)_
2. **Extract, don't redesign** — split the socket client from React; make
   `<ItxProvider>` an explicit client/authority owner.
3. **Live-resource registry** — one subscription/store per logical capability,
   selector fan-out, typed lifecycle telemetry.
4. **Prove the model on small mutable domains** — scheduler + integrations
   (read-plus-invalidate → action-plus-push).
5. **Expand capability-aligned projections** — project list, agents, repos,
   secrets, current repo state. Immutable commit/history reads stay finite reads.
6. **Remove the project server-function lookup** — slug scope + live identity.
7. **The stream migration** — server live views + paged history; retire the
   browser mirror.
8. **Delete the transitional surface** — migration-alias hooks, manual
   invalidations, compat files, and historical active docs.

Safe to do immediately: scoped reads + keying, honest remote types, doc cleanup,
behavior-preserving core extraction. Needs deliberate design: shared live-resource
identity, session-wide live project catalogs, cross-DO projection recovery, and
especially the stream-mirror replacement.
