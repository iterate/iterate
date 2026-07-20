# Frontend development (apps/os)

How we write the `apps/os` dashboard: **one programming model, a handful of thin
hooks over a capnweb capability tree reached through one WebSocket, with live
state pushed from Durable Objects** — Elixir-LiveView/Phoenix in a React
TanStack Start app.

If you only read one thing: **you talk to the backend through `itx`.** `itx` is a
capnweb `RpcStub` — a capability handle you call like a local object; the calls
travel over the tab's single `/api` WebSocket and the server answers or pushes.

The client lives in the published **`iterate` package** and is layered so every
runtime shares one implementation:

| Entry            | What it is                                                                                                                                                  |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `iterate/react`  | The hooks below. **Renderer-agnostic** — the same module runs under react-dom (this dashboard), `@opentui/react` (the chat TUI), and React Native.          |
| `iterate/client` | The framework-free layer under them: the one-socket session keeper, the live-state snapshot+patch codec, transport-error classification. No React anywhere. |
| `iterate/node`   | The node one-shot dial (`ws`, custom headers, frame observer) for scripts and e2e — `using`-scoped, no keeper.                                              |

In a browser the keeper needs zero configuration (it dials the page's `/api`
with cookie auth); non-browser consumers point it at a deployment with
`configureIterateSession({ baseUrl, credentials })` — that is the entire
difference between the dashboard and the chat TUI's data layer.

## The stack

| Concern              | What we use                                                                 |
| -------------------- | --------------------------------------------------------------------------- |
| App framework        | **TanStack Start** (SPA mode), **TanStack Router** (file-based routes)      |
| Server cache / async | **TanStack Query** (reads ride `useSuspenseQuery`/`useQuery`)               |
| RPC to the backend   | **capnweb** — promise-pipelined capability RPC over one WebSocket to `/api` |
| Forms                | **TanStack Form** + shadcn field components from `@iterate-com/ui`          |
| UI                   | **shadcn/ui** via `@iterate-com/ui/components/*`                            |
| Validation           | **Zod**                                                                     |
| Auth (identity)      | `@iterate-com/auth` client, seeded SSR-side                                 |

The backend surface (`itx`) is the project's one API — see
[`apps/os/src/README.md`](../apps/os/src/README.md) (the "four nouns") and the
generated contract [`apps/os/src/itx-api.generated.ts`](../apps/os/src/itx-api.generated.ts).

## The four nouns

- A **Session** is what `authenticate()` returns — a catalog that vends project
  itxs (`projects.list/create/get`), plus admin-only deployment-wide `streams`.
  It is _not_ itself an itx.
- A **project** is the tenant boundary (`prj_…`), its Durable Objects, its streams.
- An **itx** is a capability handle scoped into one project — `RpcStub<Project>`.
  `itx.streams`, `itx.repos`, `itx.agents`, `itx.secrets`, `itx.integrations`,
  `itx.chat`, `itx.liveState`, … Unknown dotted names fall through to the
  project's dynamic capability table.
- A **capability** is anything callable on that tree — built-in or provided.

## One socket, invisible reconnect

The whole tab shares **one** WebSocket — at most one active socket at a time,
`authenticate()`d with the signed-in session cookie, and everything — the sidebar
catalog, every project page, the stream mirror — rides it. The connection layer
([`packages/iterate/src/itx/itx-session.ts`](../packages/iterate/src/itx/itx-session.ts),
exported as `iterate/client`) keeps it in
module state (outside React) so it survives client-side navigation, and makes
**reconnect invisible**: the last session is kept across a transport gap, so a
dropped socket re-dials in the background without re-suspending the UI or showing
a spinner. Precisely: committed UI keeps rendering, resolved reads keep their
cached data (TanStack doesn't drop caches on a socket death), live subscriptions
silently re-establish, and only an **in-flight** read retries (on a finite,
transport-error-only policy — reconnect does not itself refetch resolved
queries). The one accepted edge: an imperative call fired during the sub-second
gap rides the dead stub and rejects. The full model (generations, the half-open
verifier, the semantic-vs-transport reset) is documented in that file's header
and in [`apps/os/src/itx/DECISIONS.md`](../apps/os/src/itx/DECISIONS.md) D24.

Rules of thumb (the LiveView analogy — the server owns durable reduced views,
React owns local interaction):

- **Immutable / historical / versioned / paged** data → a finite **read**.
- **Mutable current server state** → a **live projection** pushed from the DO.
- **Mutations** → just call the capability; the resulting state comes back
  through the live projection (no manual cache invalidation where a projection
  exists).
- **Ephemeral interaction state** (draft forms, open panels, URL state, optimistic
  pending) → stays in React.

## The hooks

Everything a component needs comes from one import,
`import { … } from "iterate/react"`
([`packages/iterate/src/itx/itx-react.ts`](../packages/iterate/src/itx/itx-react.ts)).

### Get a handle

```tsx
const session = useIterateSession(); // the Session catalog (suspends once, on first connect)
const itx = useItx(); // the project itx for the ambient <ProjectScope>
const itx = useItx("other-slug"); // …or a specific project by slug/id
```

Imperative siblings for event handlers / closures (can't call a hook there):

```ts
const session = await connectIterateSession();
const itx = await connectItx(slug);
```

### Read (finite, cached)

`useItxQuery` reads through a **project** itx and suspends until it resolves.
Just put it in a route component — TanStack Router wraps every route match in
`<Suspense>` (the router's `defaultPendingComponent`), so navigation shows a
spinner in the page area, never a blank. The `key` is the TanStack cache key
(prefixed with `"itx"`); include the project id so two projects can't collide.

```tsx
const files = useItxQuery({
  key: ["repo-files", projectId, repoPath],
  query: (itx) => itx.repos.get(repoPath).listFiles(),
});
```

`useIterateSessionQuery` is the **session** sibling — non-suspending (it serves the
always-mounted shell: sidebar, ⌘K, admin), same transport-only retry:

```tsx
const { data } = useIterateSessionQuery({
  key: ["projects"],
  query: (session) => session.projects.list(),
});
```

Both resolve the connection _per fetch_ (never a render-captured stub — that
would pin a dead socket after a reconnect). A resolved read shows its cached data
straight through a reconnect; only an in-flight read retries.

### Live state (server pushes)

`useLiveState` subscribes to a `.liveState` node; the server pushes a snapshot
then minimal diffs, and your **stable-slice** selector picks what you render. It
never suspends — `value` is `undefined` until the first snapshot, then the last
value stays visible through a reconnect while the subscription silently
re-establishes.

```tsx
const streams = useLiveState(
  (itx) => itx.liveState,
  (s) => s.streamsIndex,
);
// re-renders only when streamsIndex changes.
```

`useIterateSessionLiveState` is the same primitive rooted at the Session catalog,
for deployment-wide nodes such as admin streams:

```tsx
const runtime = useIterateSessionLiveState(
  (session) => session.streams.get(path).liveState,
  (state) => state,
  [path],
);
```

The selector must be a **pure function of the state** — return a stable slice
(`(s) => s.rows`), never a fresh object, and never close over props/state
(`(s) => s.rows[props.id]` goes stale invisibly: selection is cached by state
identity). Select the broader slice and index in render, or route the changing
input through `deps`.

### Act (mutations)

No extra primitive — just call the capability on the handle, usually inside a
TanStack Query `useMutation`:

```tsx
const itx = useItx();
const send = useMutation({ mutationFn: (text: string) => itx.chat.sendMessage(text) });
```

### Mount

One component. `<ProjectScope slug>` carries the ambient project slug (so
`useItx()` resolves without an argument) AND pre-warms the one socket. Mount it
under an `ssr: false` route — itx never SSRs (it dials a WebSocket and throws on
the server). No provider is needed above it: the socket is module-global and
every hook dials it lazily, so the sidebar / ⌘K / admin use itx with no
`<ProjectScope>` at all.

```tsx
<ProjectScope slug={project.slug}>
  <Outlet />
</ProjectScope>
```

`useItxSubscription` is the low-level escape hatch under `useLiveState` for
genuinely event-oriented streams (the activity tail); most UI wants `useLiveState`.

## Hooks & components — the whole surface

The entire browser API, from one file. `Itx` = `RpcStub<Project>`, a project
capability handle; a "read" is a finite cached fetch, "live" is server-pushed
state. A `slug` argument also accepts a `prj_…` id.

| Symbol                                       | Kind      | What it gives you                                                                                                                                                                                                                                                                                       |
| -------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `useIterateSession()`                        | hook      | The **Iterate session** — the catalog `authenticate()` returned (`projects.list/create/get`, admin `streams`). Suspends once, on first connect. (Named to not collide with the _auth_ session from `useAuthClient()`.)                                                                                  |
| `useItx(slug?)`                              | hook      | A **project itx** (`session.projects.get(slug)`). Defaults to the ambient `<ProjectScope>`. The everyday handle: `itx.streams`, `itx.repos`, `itx.chat`, …                                                                                                                                              |
| `connectIterateSession()`                    | fn        | Imperative `useIterateSession` — a `Promise`, for event handlers / `mutationFn`s / closures.                                                                                                                                                                                                            |
| `connectItx(slug)`                           | fn        | Imperative `useItx` — a `Promise`.                                                                                                                                                                                                                                                                      |
| `useItxQuery({ key, query })`                | hook      | Read once through a **project** itx; **suspends**. For content-addressed / historical / one-shot reads.                                                                                                                                                                                                 |
| `useIterateSessionQuery({ key, query })`     | hook      | Read once through the **session**; **non-suspending** (serves the always-mounted shell — sidebar, ⌘K, admin).                                                                                                                                                                                           |
| `useLiveState(node, selector)`               | hook      | Subscribe to a `.liveState` node; server pushes a snapshot then diffs, the stable-slice `selector` picks what you render. Never suspends. The LiveView primitive.                                                                                                                                       |
| `useIterateSessionLiveState(node, selector)` | hook      | Session-root sibling of `useLiveState`, for deployment-wide live nodes such as admin streams.                                                                                                                                                                                                           |
| `useItxSubscription(subscribe, deps)`        | hook      | Low-level escape hatch for raw ordered event streams (the activity tail). Most UI wants `useLiveState`.                                                                                                                                                                                                 |
| `<ProjectScope slug>`                        | component | Sets the ambient project + pre-warms the socket. The one mount.                                                                                                                                                                                                                                         |
| `reconnectIterateSession()`                  | fn        | The deliberate **semantic reset** — drop + re-dial the socket to pick up new claims (after creating a project / unlocking admin). Distinct from the automatic, invisible transport reconnect. Pair with `invalidateQueries({ queryKey: ["itx"] })` when cached reads must refresh under the new claims. |
| `isItxTransportError(e)`                     | fn        | Is an error a transport-close (retryable), vs auth/validation/app (not)?                                                                                                                                                                                                                                |
| `reportTransportSuspicion()`                 | fn        | Escape hatch for the **non-React** transport consumer (the browser stream mirror): "this socket looks half-open." Routes to the socket-owned verifier — which two-strike-checks and may re-dial — but **never** closes the socket itself.                                                               |
| `configureIterateSession(config)`            | fn        | Point the keeper at a deployment explicitly (`{ baseUrl, credentials }`) — the **non-browser** entry into the one-socket model (the chat TUI, keeper-based scripts). Browser apps never call it. Must run before the first connect.                                                                     |
| `Itx` (type)                                 | type      | `RpcStub<Project>` — a project handle, for typing helpers that take one.                                                                                                                                                                                                                                |
| `ItxLiveSubscriptionHandle` (type)           | type      | What any `subscribe()` returns — `ping()` + `unsubscribe()` (+ optional `[Symbol.dispose]`; the hook both unsubscribes AND disposes on teardown). The shape `useItxSubscription` drives.                                                                                                                |
| `ItxSubscriptionStatus` (type)               | type      | `"connecting" \| "live" \| "error"` — the lifecycle a subscription reports.                                                                                                                                                                                                                             |

Mutations have no hook — you call the capability on the handle
(`itx.chat.sendMessage(text)`), usually inside a `useMutation`.

That's the whole surface — one entry (`iterate/react`), no others. The everyday
four are `useIterateSession` / `useItx` / `useItxQuery` / `useLiveState`; the
rest are imperative siblings, the mount, the one escape hatch, and types. The
chat TUI consumes the SAME entry under OpenTUI — its data layer is
`configureIterateSession` + `useItxSubscription` and nothing else.

## The one exception (for now): the stream feed

The main stream feed view does **not** yet speak this model. It runs the
**browser stream mirror**: `useStreamMirror()` downloads a stream's whole event
log once per `(project, path)` and runs two processors client-side into an OPFS
SQLite database (with cross-tab leader election and durable checkpoints), and
components query it with `useStreamQuery(db, sql)` — ~4,850 LOC under
[`apps/os/src/domains/streams/client-libraries/browser/`](../apps/os/src/domains/streams/client-libraries/browser/).
It rides the same one socket (it _reports_ transport suspicion, never closes
anything), but it is a second consumption model with its own hooks. The ⌘K
switcher and stream tree already use plain `useLiveState` — the feed is the
holdout, because its projection (the rendered feed + live agent activity) is
folded in the browser today. The plan to collapse it — server-owned feed live
view + cursor-paged history, then delete the mirror — is designed in
[`apps/os/docs/stream-mirror-collapse.md`](../apps/os/docs/stream-mirror-collapse.md).
Don't build new UI on the mirror; use `useLiveState`/`useItxQuery`.

## Where the boundary is

Reads/mutations of **product** state travel the `itx` tree. The few
`createServerFn`s are request-native SSR orchestration only — auth snapshot,
cookies, root redirects, redacted bootstrap config — because they run in
`beforeLoad` before the client socket exists. Don't add a second data path; if a
component needs project data, call `useItxQuery`/`useLiveState` at the leaf.

## Where this is going

The model is ~95% in place. The non-React transport core now exists
(`iterate/client` — the TUI runs on it; React Native is the next consumer). The
remaining steps — capability-aligned live projections so mutable lists
(integrations, scheduler) stop hand-invalidating, and retiring the browser
stream mirror for server-owned live views — are laid out in
[`apps/os/docs/itx-frontend-model-roadmap.md`](../apps/os/docs/itx-frontend-model-roadmap.md).
(We deliberately did **not** collapse the two read hooks into a `useRead({ from })`:
TanStack splits suspense/non-suspense reads, so a merged hook would need an option
that flips the return type — more confusing, not less.)
