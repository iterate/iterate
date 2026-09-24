# Frontend development (dash, agents, notes, voice)

How we write the platform's client apps — `apps/dash`, `apps/agents`,
`apps/notes`, `apps/voice` (and Kit's installer): **one programming model, a
handful of thin pieces over a capnweb capability tree reached through one
WebSocket, with live state pushed from Durable Objects** — Elixir-LiveView/Phoenix
in a React TanStack Start app.

If you only read one thing: **you talk to the backend through the session and
its contexts.** The session is a capnweb `RpcStub` — a capability handle you call
like a local object; the calls travel over the tab's single `/api` WebSocket and
the server answers or pushes.

The client lives in the published **`iterate` package** under `iterate/*`
and is layered so every app shares one implementation:

| Entry                | What it is                                                                                                                                                                                                                         |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `iterate/react`      | The two React hooks below (`useLiveState`, `useIterateContext`) — the ONE file that imports React. The rendering half (`ContextView`, `AppShell`) lives in `@iterate-com/ui`, so the UI kit stays free of the SDK.                 |
| `iterate/app`        | `createIterateClient` — the browser's one-socket session: login probe, the socket to the page's own `/api`, and reconnect on the next call. No React anywhere.                                                                     |
| `iterate/client`     | The framework-free live-state client: `createLiveStateStore` (seed, apply deltas, heal a gap) and `connectLiveState` (wire a context's `subscribe` and a seed read to the store). Node test clients use the same code.             |
| `iterate/app-server` | The app Worker's half: `appAuth` (the OAuth client, the `/.auth/*` pages and the authenticated `/api` proxy), `appSession`, `issuerOriginOf`. With `BrowserSession` from `iterate/app-session`, the Durable Object each app binds. |
| `iterate/api`        | The declared shapes of the platform's `/api`: `IterateApi`, `IterateSessionApi`, `IterateContextApi` — what an app types against.                                                                                                  |
| `iterate/node`       | `connectIterate({ baseUrl, auth })` — the node one-shot dial (`ws`) for scripts and the CLI; `Disposable`, never retried.                                                                                                          |

In a browser the client needs zero configuration beyond its scopes (it dials
the page's own `/api`, and the app Worker's `appAuth` gate forwards it to the
platform with the session's bearer); non-browser consumers dial a deployment
with `connectIterate({ baseUrl, auth })` and a `SessionCredentials` value. That
is the entire runtime-specific binding around the shared client.

## The stack

| Concern              | What we use                                                                                                 |
| -------------------- | ----------------------------------------------------------------------------------------------------------- |
| App framework        | **TanStack Start** on the app's own Worker (`@cloudflare/vite-plugin`), **TanStack Router** (file-based)    |
| Server cache / async | Route **`loader`s**; a mutation calls `router.invalidate()` to reload them. No TanStack Query in the apps   |
| RPC to the backend   | **capnweb** — promise-pipelined capability RPC over one WebSocket to the app's `/api`                       |
| Forms                | Plain React state + `Field`/`Input` from `@iterate-com/ui`, in a URL-driven `Sheet` (`?new=1`, `?update=…`) |
| UI                   | **shadcn/ui**, vendored, via `@iterate-com/ui/components/*`; the shared `AppShell` frame and `ContextView`  |
| Validation           | **Zod** — a live-state seed and a `/.auth/*` answer are parsed, never cast                                  |
| Auth (identity)      | The SDK's OAuth client: `appAuth` + `BrowserSession` on the server, `info.scopes` in the page               |

**Light mode only**, in every app and page: no dark palette, theme provider or `dark:` class of our own. `dark:` never matches: `@iterate-com/ui/globals.css` switches it off.

**The shadcn components are vendored** ([packages/ui/AGENTS.md](../packages/ui/AGENTS.md)): each file is exactly what `shadcn add` writes, and nobody edits one. Customise a component at the call site (a `className`, a prop) or in a wrapper of our own in `packages/ui`. They keep upstream's `dark:` classes: don't strip them. Refresh them all with `pnpm tsx scripts/ci/shadcn-drift.ts refresh`, then review the diff. A pull request that touches one runs the drift check (`.depot/workflows/shadcn-drift.yml`), which fails when a file differs from `shadcn add`. `cn` comes from the `cn` package.

The backend surface is the platform's one API — declared in
[`packages/iterate/src/api.ts`](../packages/iterate/src/api.ts) (never
generated; `apps/os` asserts its classes satisfy it), and served by
[`apps/os`](../apps/os/README.md).

## The four nouns

- A **Session** is what `authenticate()` returns (`IterateSessionApi`) — who is
  calling (`whoami`, `info`), their `grants`, and a catalog that vends contexts
  (`projects.list/create/get`, `organizations.list/get/create`, `user`). It is
  _not_ itself a context.
- A **project** is the tenant boundary (`prj_…`), its Durable Objects, its streams.
- A **context** is a capability handle scoped into one place — a project's `/`,
  a path under it (`cd(path)`), an organization, the user (`IterateContextApi`).
  `append`, `readEvents`, `subscribe`, `secrets`, `repos`, `facets`,
  `processors`, `schedules`, `files`, `ai`, … A context has ONE method at heart,
  `invoke(call, ...args)`, and the stub proxies the dotted spelling onto it, so
  names the declared roots don't list resolve through the context's rewrite
  rules and provided capabilities.
- A **capability** is anything callable on that tree — built-in or provided.

## One socket, invisible reconnect

The whole tab shares **one** WebSocket — `authenticate()`d with the session the
app Worker's OAuth gate resolved from its `__Host-` cookie — and everything — the
shell's project switcher, every page, every live subscription — rides it. The
connection layer ([`packages/iterate/src/app.ts`](../packages/iterate/src/app.ts),
exported as `iterate/app`) keeps it in module state (outside React), so it
survives client-side navigation, and makes **reconnect cheap and quiet**:
connecting tries for a while (`openSocketWithRetry` in
[`client/socket.ts`](../packages/iterate/src/client/socket.ts), ≈16 s of
attempts) before an error reaches the page, and the `api` a page holds is a proxy
to the CURRENT connection — when the socket closes, the next call opens a fresh
one and pipelines onto it, so a dropped connection costs a reconnect, not the
page. A reconnect the platform refuses (the session ended elsewhere) rejects that
call; the page's retry runs `authenticate` again, whose `/api` probe sends the
browser to log in. HTTP, not the socket, decides that: a failed WebSocket is not
evidence that the visitor needs to log in.

What reconnect does not do: a live subscription is bound to the socket it was
made on. `useLiveState` and `useIterateContext` re-subscribe when the handle you
pass them changes, and deliberately carry no reconnect/backoff/ping policy of
their own — "that policy belongs to whoever owns the capnweb session"
([`client/react.tsx`](../packages/iterate/src/client/react.tsx)).

Rules of thumb (the LiveView analogy — the server owns durable reduced views,
React owns local interaction):

- **Immutable / historical / versioned / paged** data → a finite **read**.
- **Mutable current server state** → a **live projection** pushed from the DO.
- **Mutations** → just call the capability; the resulting state comes back
  through the live projection (no manual reload where a projection exists).
- **Ephemeral interaction state** (draft forms, open sheets, URL state, optimistic
  pending) → stays in React.

## The hooks

A page gets its handles from the route context and its live data from one
import, `import { … } from "iterate/react"`
([`packages/iterate/src/client/react.tsx`](../packages/iterate/src/client/react.tsx)).

### Get a handle

Create the client once per app, at module scope of the signed-in layout route,
and authenticate in its client-only `beforeLoad`; every child route reads the
result from its context:

```tsx
const iterate = createIterateClient({ scopes: ["iterate", "account"] });

export const Route = createFileRoute("/_auth")({
  ssr: false,
  beforeLoad: ({ location }) => iterate.authenticate(location.href), // → { api, info, signInFor }
});

const { api, info } = Route.useRouteContext(); // or getRouteApi("/_auth").useRouteContext()
const context = await api.projects.get(project.id); // a project's root context, by slug or id
```

A context handle a component holds for its life is disposed on unmount
(`stub[Symbol.dispose]()`), and handed to a state setter as `setContext(() => stub)` —
a capnweb stub is a callable proxy, and React would take it for an updater and
call it (dash `routes/_auth/projects/$slug/index.tsx`, `useProjectContext`).

### Read (finite, cached)

A read is the route's **`loader`**: it runs after `beforeLoad`, TanStack Router
shows the router's `defaultPendingComponent` while it does (so navigation shows a
spinner, never a blank — every app sets one, with `defaultPendingMs: 300`), and
the page reads it with `Route.useLoaderData()`:

```tsx
export const Route = createFileRoute("/_auth/projects/$slug/secrets")({
  loader: async ({ context }) => ({
    secrets: await context.api.projects.get(context.project.id).secrets.list(),
  }),
});
```

The shell's session reads, the organization tree, are made once by
`<OrganizationTree>` (`apps/dash/src/components/organization-tree.tsx`) and
shared by every page through `useOrganizationTree()`: live state on `api.user`
and `api.organizations.get(orgId)`, or `organizations.list()` and
`projects.list()` when the session cannot open the account. Resolve the
connection _per call_ through `api` (never a render-captured stub of a closed
socket): the proxy hands every call to the live connection.

### Live state (server pushes)

`useLiveState` subscribes to one producer's live state — a processor facet, a
mini-app — seeds from its `{ rev, state }` read (`readSeed`), then applies every delta the server
pushes. It never suspends: `value` is `undefined` until the first seed, `status`
is `"connecting" | "live" | "error"`, and the last value stays visible while a
gap heals from a fresh seed.

```tsx
const live = useLiveState<unknown>(context, {
  key: "project",
  readSeed: async () =>
    z
      .object({ rev: z.number(), state: z.unknown() })
      .parse(await context!.invoke("itx.facets.get('project').liveSnapshot()")),
});
const parsed = ProjectLive.safeParse(live.value).data; // parse the value, never cast it
```

`useIterateContext` is the whole-context sibling — ONE hook, one stream
subscription: every committed event of the context (subscribed BEFORE the
catch-up read, deduped by offset, `caughtUp` once at the head), the processors
table (re-read when the log grows a subscription change), who is here
(`itx.rpcStubs.list()` plus every principal on the log), and named facets' live
state (`core` plus every hosted facet by default, or exactly `liveState: [...]`):

```tsx
const iterateContext = useIterateContext(context, { consumes: FEED_SUBSCRIPTION });
// iterateContext.events, .caughtUp, .processors.rows, .presence.actors, .liveState.core
```

The `readSeed` thunk may be a fresh arrow every render; the hook pins the one it saw
when it connected, so an old subscription's gap heal never reads a newer key's
seed. Pass `undefined` as the handle until you have one — both hooks wait for it.

### Act (mutations)

No extra primitive — just call the capability, then let the result come back:
through the live projection where there is one, or by reloading the loaders:

```tsx
await api.projects.get(project.id).secrets.set(path, value, { urls: origins });
await router.invalidate({ sync: true }); // the secrets list is the route's loader
```

`sync: true` makes the call wait for the reload. Without it, TanStack Router reloads a route that
already has data in the background (`loaderShouldRunAsync && !inner.sync` in router-core's
`load-matches.ts`): `invalidate()` resolves at once, the action's pending state ends ("Installing…",
the form's spinner), and the page shows its old data until the reload lands, so the action looks as
if it failed. That happened to Voice's install on a busy platform (#3016). While the reload runs,
the page keeps its data, and no pending component shows. An action that navigates next can skip
`sync`, because the navigation waits for its own load.

### Mount

No provider. The client is module state; the signed-in layout route is
`ssr: false` (the session dials a WebSocket and never runs on the server), and
its `beforeLoad` is the one place `authenticate` is called. The frame is the
shared `AppShell` from `@iterate-com/ui` (the same frame dash, agents, notes and
voice use), filled with the `_auth` loader's projects.

```tsx
<AppShell app="iterate" projects={…} …>
  <Outlet />
</AppShell>
```

`connectLiveState` from `iterate/client` is the low-level escape hatch under
both hooks, for a non-React consumer or a test that awaits a store; most UI wants
the hooks.

## Hooks & components — the whole surface

The entire browser-facing API. A "handle" is a capnweb stub of a context
(`IterateContextApi`); a "read" is a finite fetch, "live" is server-pushed state.

| Symbol                                              | Kind      | What it gives you                                                                                                                                                                                |
| --------------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `createIterateClient({ scopes })`                   | fn        | The app's one client (`iterate/app`). Create once per app.                                                                                                                                       |
| `iterate.authenticate(next?)`                       | fn        | Probe `/api`, open the socket, resolve `{ api, info, signInFor }` — or leave for `/.auth/login` (never settles) when there is no session. Single-flight; a failure lets the next call try again. |
| `api`                                               | stub      | The **session** (`IterateSessionApi`), proxied to the current connection: `projects.list/get/create`, `grants`, `organizations.list/get/create/…`, `user`, `logout()`.                           |
| `info`                                              | data      | `{ principal, scopes, platformOrigin, ingressRouting, mcpOrigin }` — the granted `scopes` decide what a page offers (consent is task-based: optional scopes may be unticked).                    |
| `signInFor(project)`                                | fn        | The page names a project this sign-in does not include: leave for `/.auth/login`, which offers to sign in again and returns to this URL.                                                         |
| `useLiveState(itx, { key, name?, readSeed })`       | hook      | Subscribe to one producer's live state; seed through `readSeed`, apply pushed deltas, heal a gap. Never suspends. The LiveView primitive.                                                        |
| `useIterateContext(itx, { consumes?, liveState? })` | hook      | The context, live: `events`, `caughtUp`, `error`, `processors`, `presence`, `liveState` — the data half of `ContextView`.                                                                        |
| `connectLiveState(itx, opts)`                       | fn        | The framework-free client under both hooks (`iterate/client`): a store plus `dispose()`.                                                                                                         |
| `createLiveStateStore()`                            | fn        | The pure reduce: `seed`, `apply` (gap ⇒ resync), `get`, `rev`, `subscribe`.                                                                                                                      |
| `ContextView`, `AppShell`                           | component | The rendering half, from `@iterate-com/ui` — pure components, no SDK import.                                                                                                                     |
| `LiveStateResult<S>` (type)                         | type      | `{ value, rev, status, error? }` — what `useLiveState` returns and each `useIterateContext().liveState` entry is.                                                                                |
| `LiveStateStatus` (type)                            | type      | `"connecting" \| "live" \| "error"`.                                                                                                                                                             |
| `IterateContextHandle` (type)                       | type      | The slice of a context the context hook reads; a capnweb context stub satisfies it structurally.                                                                                                 |
| `IterateContextPresence` (type)                     | type      | One presence as the hook hands it out; events are `StreamEvent` (`iterate/stream/processor`), processor rows `SubscriptionListEntry` (`iterate/api`).                                            |

Mutations have no hook — you call the capability on the handle
(`context.secrets.set(...)`, `api.organizations.create({ name })`), then
invalidate or let the projection answer.

That's the whole surface. The everyday four are `createIterateClient` /
`useLiveState` / `useIterateContext` / the route `loader`; the rest are the
low-level client, the UI kit's pure components, and types.

## One consumption model, the stream feed included

The agents app's feed is `useIterateContext` over the agent's context
(`apps/agents` `routes/_auth/projects.$slug.tsx`, `useAgentLog`): the log in
memory, deduped by offset, reduced for the chat by `lib/agent-events.ts`.
Don't build new UI on a second client-side store; use
`useLiveState`/`useIterateContext` and a server-owned projection.

## Where the boundary is

Reads/mutations of **product** state travel the capnweb tree. The app Worker
itself does only request-native work before TanStack Start sees the request:
`appAuth` (the OAuth client, its `/.auth/*` pages and the authenticated `/api`
proxy), a health check, and a signed-in redirect off the landing page
(`apps/dash/src/server.ts`, Start's server entry). Each app's root route has one
`createServerFn`, which reads the Worker's `POSTHOG_PROJECT_KEY` for PostHog; there are no others.
Don't add a second data path; if a component needs project data, read it in the
route `loader` or subscribe with `useLiveState`/`useIterateContext` at the leaf.

## Secrets on the page

In production every app, and the platform's sign-in pages, record PostHog session replays of what
people type and see (`sessionRecordingPrivacy` in `packages/ui/src/components/not-recorded.tsx`).
Secrets never go in one:

- A field that takes a secret (a password, an API key, a secret's value, a sign-in code) is a
  `SecretInput` or `SecretTextarea`. `iterate/secret-field-not-recorded` flags a raw input or
  textarea that says it takes one by its `type`, `autoComplete`, `id`, `name` or `aria-label`.
- A secret on screen (a personal access token or an invite link shown once) goes inside a
  `NotRecorded`.

Both replay as an empty box, and autocapture skips them. Any other password input replays as
`***`. `posthog-replay.test.tsx` runs posthog-js's own recorder on these components.

## Where this is going

The model is small on purpose: the SDK's React surface is two hooks over one
framework-free client, and the UI kit renders what they return without importing
the SDK. Mutable lists that no projection pushes yet (secrets, organizations,
grants) reload through `router.invalidate()`; each one that gains a live
projection drops its invalidation. (We deliberately did **not** merge reads into
a hook with an option that flips its return type: a finite read is a route
`loader`, live state is a hook — two shapes, not one confusing one.)
