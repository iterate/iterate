# OAuth app-shape review

Reviewer: Claude Fable 5.1, effort xhigh. Exact model verified from CLI model usage. Read-only review; no permission denials.

Done reading. Here is the bounded answer.

**Recommendation: A**, in the specific shape below. It is the only option where the platform host and a userspace clone run the same route files and the same browser helper, and it removes the second auth path instead of adding a third.

## What exists today and why it is two paths

The authenticated console pages reach data through Start server functions that need `env.DB`, `OAUTH_PROVIDER` and `ITERATE_CONTEXT` (`_auth/index.tsx`, `_auth/sessions.tsx`, `grants.ts`, `control-plane.ts` `accountOf`). The Notes app reaches the same data through the same-origin `/api` Cap'n Web session, which the browser adapter already resolves from the private `BrowserSession` DO on every origin. Both paths end at the same bearer and the same `authorizationOf`, but only the second is portable. The `Session` root over `/api` already exposes `whoami()` and `projects.list/get/create` (`session.ts:207-215`). What it lacks is orgs, the project host base, and grants.

Selective SSR is available: `ssr?: SSROption` exists in the installed router-core 1.168.3, the repo already uses `ssr: false` on `apps/os` leaves, and `docs/frontend-development.md:186` states the idiom ("itx never SSRs"). Setting `ssr: false` on the pathless `_auth.tsx` layout is inherited by its children, so one line covers the group, and the root shell still SSRs.

## The refactor

**Move to `/api` (server side, `session.ts`, `grants.ts`, `rpc.ts`)**

- Add `Session.orgs()` (directory.listOrgs on the principal's actor) and `Session.platform()` returning `{ projectHostnameBase }` from `appConfig`. About 15 lines. The account page derives "open" links from these.
- Turn `listGrants`, `endGrant`, `mintPersonalToken` into a `Grants extends RpcTarget` in `grants.ts`. Replace their `requireBrowserSession(env, request, ctx)` with an `Authorization` passed at construction. `rpc.ts` already holds `env`, `ctx` and `auth`, so it builds `new Grants(env, ctx, auth)` and hands it to `Session`, exposed as `get grants()`. An admin session (no grant) gets FORBIDDEN. Delete `grantsDoor` and its form posts.
- Export the `Grants` type from `types.ts`.

**Delete from the issuer half (`control-plane.ts`, `browser-client.ts`, `routes/-session.ts`)**

- `accountOf`, `appLabelsOf`, `Account`, `createProjectFor`, the `/projects` door, the `grantsDoor` call. App labels come from `itx.invoke("itx.rewriteRules.list()")` on the project root, pipelined from the browser under the same principal as `invokeAs` used.
- `browserSessionOf` and `requireBrowserSession` lose all callers and go. `sessionOf` goes; `issuerOf` stays for `/authorize`.
- What remains issuer-only and SSR with env: `login.tsx`, `authorize.tsx`, `-console-context.ts`, `consoleDoor` for `/login`, `/logout`, `/authorize`, and `identityDoor`. Google stays exactly where it is: an identity proof into our provider. Apps and the console still consume our provider's grants through the adapter.

**One shared browser helper, `src/client/api.ts`, exported as `project-worker/client/api`**

- `connectApi()` opens one module-global `newWebSocketRpcSession<Session>` to same-origin `/api` over wss, disposes on `pagehide`. This is the code already in `apps/notes/src/app.ts:11-24`, moved.
- `requireSession(location)` awaits `api.whoami()`, and on rejection throws `redirect({ href: "/.auth/login?next=...", reloadDocument: true })`. A signed-out socket gets a 401 handshake and capnweb rejects the pending call, which Notes already relies on. About 40 lines total.

**Route group (`routes/_auth.tsx`, `_auth/index.tsx`, `_auth/sessions.tsx`)**

- `_auth.tsx` gets `ssr: false` and a `beforeLoad` that returns `{ api, who }` from the helper. No env, no provider, no `createServerFn` imports anywhere under `_auth/`.
- Loaders call `context.api.projects.list()`, `context.api.orgs()`, `context.api.grants.list(cursor)`. Mutations call `api.projects.create`, `api.grants.end`, `api.grants.mint`, then `router.invalidate()` as today. The `-console-context` middleware disappears from these files. Net about 30 lines removed.

**Notes becomes the same app shape (`apps/notes`)**

- Add Start to `vite.config.ts` and `package.json` (react, react-dom, router, start, plugin-react). Add `router.tsx`, `routes/__root.tsx`, `routes/_auth.tsx` and `routes/_auth/index.tsx`. The `_auth.tsx` file is byte-identical to the console's; the editor becomes a component reading `Route.useRouteContext().api`. Delete `index.html` and `app.ts`. Keep `/healthz` in the worker entry. Roughly 100 lines net.
- `config-worker.ts` is unchanged: `this.auth.require(request)` then proxy. The proxied Start shell carries no user data, so the stripped principal and cookie at egress cost nothing. Notes on its bare origin still cannot sign in, as today; that is the ingress dependency you already accept.

**Fixed-host guard (`worker.ts` or the tail of `consoleHandler`)**

- After assets and the machine doors, for requests not on the issuer allowlist (`/login`, `/authorize`, `/_serverFn/*`), compute `browserAuthorization`, stamp `ITX_PRINCIPAL_HEADER` on a cloned request when present, and run the same `auth.require(request)` from `sdk/auth.ts`. That file imports only zod and `principal.ts`, so the worker can import it directly. Signed-out GET of `/` stays a server 302 with no shell flash, exactly as the ConfigWorker does on a project host. About 12 lines.

## Guard authority, stated plainly

On both host kinds the only party that resolves identity is the edge, from the `BrowserSession` DO, per request. On a project host it stamps a principal into the DO fetch lane, the ConfigWorker gate reads that stamp, and egress strips it before any app backend. On the platform host the same gate runs in-process with the same stamp. The app backend, including Notes at `notes.iterate2.com`, never receives a cookie, a bearer or a stamp and is never trusted for anything. All personal data flows over the browser's own `/api` socket, which the adapter authorizes and `rpc.ts` re-checks every 30 seconds. No new BFF RPC, no forwarded headers, no server transport.

## Why not B

B requires the app backend to hold the user's session for SSR, so the opaque cookie or bearer must be forwarded to `notes.iterate2.com`. That creates a second trusted party, needs a forwarding proxy with SSRF and audience controls, and contradicts the egress design that strips exactly those headers. Worse, the platform host would still read the DO in-process while the clone would go over the network, so the two would not share code paths, which is the one thing the clarification forbids. Several hundred lines and a new trust boundary for SSR'd user data you have said you do not need.

## Size and tests

Net change is roughly 200 lines removed and 200 added in `project-worker`, plus about 100 in `apps/notes`. The existing workers-lane test in `oauth.test.ts:385-449` that posts to `/sessions/token` and `/sessions/revoke` moves to `root.grants.mint(...)` and `root.grants.end(...)` over the same `rpc(token)` helper it already uses, and the `listGrants` direct call becomes `root.grants.list()`. The console redirect assertion in `control-plane.test.ts` is unchanged because the fixed-host guard still 302s.

One scope drop to consider: the pre-hydration form fallbacks on the account and sessions pages stop working under `ssr: false`. Since the machine doors they posted to are deleted anyway, remove the `action=` attributes and keep `onSubmit` only.
