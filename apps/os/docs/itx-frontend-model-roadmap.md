# itx frontend programming model — roadmap

The end-state for apps/os's React/TanStack Start frontend, and the path there.
PR #2048 (one WebSocket per tab) is step one and landed the whole hook surface;
this doc captures the _further_ refactors, reviewed by two survey subagents +
codex (gpt-5.6-sol, max reasoning). The day-to-day guide is
[`docs/frontend-development.md`](../../../docs/frontend-development.md); this is
the where-it's-going companion.

## The model we're converging on

> A single simple programming model: a capnweb capability tree over ONE WebSocket,
> a small number of React hooks/providers stacked thinly on a _very_ narrow core,
> and Elixir-LiveView/Phoenix-style live updates of state in (mostly) Durable
> Object isolates.

The governing rule (the useful LiveView analogy — the server owns durable reduced
views; React renders + owns local interaction):

- **Immutable / historical / versioned / paged / expensive** reads → a finite read
  (`useItxQuery` / `useIterateSessionQuery`).
- **Mutable current server state** → a live projection pushed from the owning DO
  (`useLiveState`).
- **Mutations** → direct capability calls; their result arrives back through the
  live projection — no caller-level invalidation.
- **Ephemeral interaction state** (draft forms, open panels, URL state, optimistic
  pending markers) → stays in React.

The public hook set is intentionally small and stacked on a framework-free core:
`useIterateSession()` / `useItx(slug)` (capabilities + actions), the two read
hooks `useItxQuery` / `useIterateSessionQuery` (finite cached reads — project vs
session, suspending vs not), `useLiveState()` (server-owned live projections),
plus imperative `connectIterateSession()` / `connectItx(slug)`. Everything else
(generations, liveness, verification, stores, subscription recovery, query
scoping) is an implementation detail of the narrow core.

> We deliberately did **not** collapse the two read hooks into one
> `useRead({ from })`. TanStack Query splits suspending (`useSuspenseQuery`) from
> non-suspending (`useQuery`) reads, so a merged hook would need an option that
> flips its return type — more confusing, not less. Two named hooks (project
> read = suspends; session read = shell, non-suspending) is the honest surface.

## Where we already are (verified survey)

The frontend is **~95% converged** already: one socket, no `EventSource`, no oRPC
client, no `useEffect`+`setState` fetch loops for server data. The five
`createServerFn`s are all SSR/auth boundaries (run in `beforeLoad` before the
client socket exists) and correctly stay server-side; the only two `fetch()`es
set a cookie / hit external `$schema` hosts; the only `refetchInterval`/
`setInterval` poll client-side stores / a UI clock. There is no "gunk pile" — the
remaining work is _completing_ the model, not undoing a parallel one.

## Done in PR #2048

- **One WebSocket per tab** — a module-global socket, a Session gate
  (`useIterateSession`), slug-addressed `useItx`, and **invisible reconnect**
  (last session kept across a transport gap; only in-flight reads retry). The full
  model — generations, the half-open verifier, the semantic-vs-transport reset —
  is in `itx-react.tsx`'s header and DECISIONS.md D24.
- **`itx.projects.get(slug)`** — the collection resolves a slug _or_ a `prj_…` id
  (`resolveProjectIdBySlug` in `rpc-targets.ts`), so `useItx("my-slug")` works
  straight from a URL param.
- **`useIterateSessionQuery`** — the session-scoped sibling of `useItxQuery` (same
  transport-only retry, non-suspending for the always-mounted shell). Folds the
  hand-rolled `session.projects.list()` reads (sidebar, /projects, ⌘K picker,
  admin) onto one primitive and shrinks `lib/projects-query.ts` to a shared key.
- **Deleted `<ItxProvider>` and the 12 per-page `<ItxBoundary>` wrappers.** The
  socket is module-global and every hook dials it lazily, so no provider is needed;
  TanStack Router already wraps every route match in `<Suspense>` (its
  `defaultPendingComponent`), so the per-page boundary was redundant. `ProjectScope`
  now carries the ambient slug _and_ pre-warms the socket — the one mount.
- **No public-boundary casts.** The old `as unknown as` casts are gone; the exported
  surface types cleanly against `RpcStub<Session>` / `RpcStub<Project>`.
- **The frontend guide** — `docs/frontend-development.md`, linked from the root
  README, documents the whole model + the hook/component table.

## No-brainers (next, small + safe)

- **`useProjectLiveState`** — hoist the `(itx) => itx.liveState` accessor repeated
  ~10× (`useLiveState((itx) => itx.liveState, sel, deps, opts)` →
  `useProjectLiveState(sel, deps, opts)`). Keep `useLiveState` for the non-root
  nodes (`itx.liveDemo.ticker`, `secrets.get(p).liveState`, …).
- **Retire the historical `itx/README.md`.** It still describes the pre-itx-v4
  kernel and deleted files; the current browser model now lives in
  `docs/frontend-development.md`, so trim the README to a short pointer.

### Considered and kept as-is

- **`useItxEffect` stays a separate private hook.** Both reviews floated folding
  it into `useItxSubscription` (its only caller). We evaluated and kept it split:
  it isn't exported, so it's not public surface, and it cleanly isolates one
  subtle concern — a _reconnect-aware itx effect_ (await the itx inside the effect
  so mounting never suspends; re-run on the session generation so a reconnect
  recovers; run late async cleanup even if you unmounted mid-await; route dial
  errors out). `useItxSubscription` layers a different concern on top (the
  connecting/live/error machine + the liveness watchdog + retry). Inlining would
  merge two ~30/~90-line single-responsibility pieces into one dense function
  mixing five concerns — harder to explain, not easier — and it's the seam future
  subscription hooks will reuse.

## Medium

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
- **Canonical scoped read keys.** Cache correctness currently depends on every
  `useItxQuery` caller remembering to put the project id in its `key` (the D24
  footgun). A central key factory that mechanically namespaces project reads by
  slug — without changing the public hook signatures — closes it.

## Large (need design)

- **Extract a non-React `BrowserItxClient` core** (codex #6) behind a tiny
  interface (`getSnapshot`/`subscribe`/`connectSession`/`connectProject`/
  `resetAuthority`/`reportTransportSuspicion`), split into e.g. `itx/socket.ts`
  (transport, generations, verification), `itx/live-resource.ts` (shared stores,
  subscription/revision recovery, watchdogs), `itx/read.ts` (scoped keys + TanStack
  adapter), and `itx-react.tsx` (contexts + the thin hooks). Move
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

1. **Immediate no-brainers** — `useProjectLiveState`, retire the historical README.
2. **Extract, don't redesign** — split the non-React socket client from React.
3. **Live-resource registry** — one subscription/store per logical capability,
   selector fan-out, typed lifecycle telemetry.
4. **Prove the model on small mutable domains** — scheduler + integrations
   (read-plus-invalidate → action-plus-push).
5. **Expand capability-aligned projections** — project list, agents, repos,
   secrets, current repo state. Immutable commit/history reads stay finite reads.
6. **Remove the project server-function lookup** — slug scope + live identity.
7. **The stream migration** — server live views + paged history; retire the
   browser mirror.
8. **Delete the transitional surface** — manual invalidations and historical
   active docs.

Safe to do immediately: `useProjectLiveState`, doc cleanup, behavior-preserving
core extraction. Needs deliberate design: shared live-resource identity,
session-wide live project catalogs, cross-DO projection recovery, and especially
the stream-mirror replacement.
