# project-worker — the clean-room platform, ONE worker

One Cloudflare Worker, one package: `src/worker.ts` is the stateless edge (capnweb at `/api`;
project-host ingress — `<app>--<project>.<base>`, `<app>.<project>.<base>`, the apex
`<project>.<base>` — the one HTTP way into a project; the static assets on the platform host) with
the control plane in-process as its catch-all (`src/control-plane.ts`: OAuth AS + a D1 directory +
`/mcp`, the ONE MCP server for every project + the console's server half) and THE CONSOLE — a
TanStack Start app (`src/routes/**`: `/login`, the account page at `/`, the `/authorize` consent),
SSR'd by the same worker, its server functions calling that server half;
`src/iterate-context-durable-object.ts` is THE CONTEXT — one Durable Object per `{ projectId, path }`
holding the event log, the core reduce, subscription delivery, the facets, the rpc-stub pagers and
the fetch door. Everything a client does is one dotted expression on `itx`.

```ts
using api = newWebSocketRpcSession("wss://<worker>/api"); // the client's only dependency: capnweb
const session = api.authenticate({ type: "from-server-cookie" }); // the console's login cookie rode the handshake
const itx = await session.projects.create({ project: "my-project" }); // → the project's root context
await itx.append({ type: "note", payload: { n: 1 } });
```

`authenticate(credentials)` takes one of four kinds (`src/session.ts` `SessionCredentials`):
`from-server-cookie` (a browser — same origin only), `project-token` (one user on one project),
`admin-secret` (every project; with `as` a user's session without a login — the e2e lane, tooling),
`project-secret` (the project itself — a device, a headless app; `projects.get(project).rotateApiKey()`
mints the key, `.mintToken()` a project token).

An MCP client connects to `https://<worker>/mcp` through the same login: the OAuth 2.1 AS is the
worker itself (`/authorize`, `/oauth/token`, `/oauth/register`, `/.well-known/*`), the consent page
picks the projects the token may reach, and the tools are `whoami`, `list_projects` and
`itx.invoke({ project?, expression, args? })` — one expression, evaluated through that project's
context under the caller's principal (a project is created on the console or over `/api`). The
admin secret and a project's own secret (`/mcp?project=<id>`) are bearers on `/mcp` too.

## Read next

- `docs/itx-surface-as-built.md` — every signature, transcribed from source (start here)
- `docs/clean-room-api-walkthrough.md` — the long-form walkthrough, module by module
- `docs/design-onion-subscriptions-processors.md` — the design of record for subscriptions + processors
- `LAYERS.md` — the layer map; `BUILD-LOG.md` — what landed, when, and the proofs
- `docs/plan-v4-features-layered-on-v3.md` — the roadmap (its STATUS block says what is done)
- `docs/history/` — every earlier plan, review, proposal and log, dated; read as history, never as the code

## Configuration

`APP_CONFIG_*` vars, parsed once per isolate by `src/worker.ts` `parseAppConfig` (an unknown one is
refused). The three secrets are wrangler secrets on a deployment (`wrangler secret put <name>`),
plain vars in the test lanes:

| Var                                                                 | Required | What                                                                                         |
| ------------------------------------------------------------------- | -------- | -------------------------------------------------------------------------------------------- |
| `APP_CONFIG_ENVIRONMENT_NAME`                                       | yes      | the deployment's name at `/version` ("poc", "test", "e2e")                                   |
| `APP_CONFIG_SESSION_SECRET`                                         | yes      | signs the ten-minute Google login flow (secret)                                              |
| `APP_CONFIG_ADMIN_API_SECRET`                                       | yes      | the admin secret: `authenticate({ type: "admin-secret" })`, the lanes' admin bearer (secret) |
| `APP_CONFIG_PROJECT_TOKEN_SECRET`                                   | yes      | signs operator-only project credentials (secret)                                             |
| `APP_CONFIG_PROJECT_HOSTNAME_BASE`                                  | no       | the base project hosts hang under; blank ⇒ no project-host ingress                           |
| `APP_CONFIG_TEST_EMAIL_LOGIN`                                       | no       | `true` permits unverified email sign-in; disabled remotely by default                        |
| `APP_CONFIG_ARTIFACTS_ACCOUNT_ID`, `APP_CONFIG_ARTIFACTS_NAMESPACE` | no       | `itx.repos`' git remotes                                                                     |

## The console

The dashboard, session management and OAuth consent are client-only TanStack Start routes.
They share one `createIterateClient` and an ordinary `/api` Cap’n Web session. The dashboard
component and loader are also used verbatim by the independently hosted Notes app.

Google login proves identity to our issuer. Its callback establishes one ordinary, revocable
issuer grant through the same `BrowserSession` used by other apps. There is no separate
identity cookie. The explicit `/login` page has a small server function for safe login options;
the test/admin `POST /login` path establishes that same issuer session.

For the isolated `os.iterate2.com` deployment, `testEmailLogin: true` in `envs.ts`
enables the email form at [Sign in](https://os.iterate2.com/login). Enter any email
to assume that user immediately, without verification. Localhost also offers this
form. Other deployments require Google unless they explicitly enable test login.

Only that issuer grant receives `session.consent`. The `/authorize` SPA can create an
organization and project through `session.createOrg` and `session.projects.create`, then
approve the pending client's access without leaving the flow. Other apps may request account
permission through explicit consent, but cannot approve grants. All apps use the same
`/.auth/*` adapter, opaque HttpOnly cookie, public token exchange and `/api` proxy.

See [the current OAuth design](../../../docs/unified-oauth-architecture.md) for boundaries,
revocation and the deferred impersonation design. The historical walkthroughs describe the
pre-unification project-credential interface; they are not the public authorization contract.

## Build, run, deploy

The build is Vite's (`vite.config.ts`: the Cloudflare plugin + TanStack Start + React; `build-sdk.mjs`
runs at config load for the processor SDK bundle and the hosted `/demo` page). `vite build` emits
`dist/client` (the console's bundle + `public/`) and `dist/server` (the worker + `wrangler.json`,
the config a deploy and both local lanes consume). The Cloudflare Vite plugin's own workerd is older
than this worker's compatibility date, so local dev is the built worker under this package's wrangler:

```bash
pnpm dev -- --port 8788         # vite build, the directory schema into the local D1, wrangler dev on dist/server/wrangler.json
                                # (project hosts under `<project>.localhost:8788`; dev values for the three secrets — scripts/dev.ts)
pnpm build                      # dist/client + dist/server
pnpm run typecheck              # routes:check, then the three tsconfigs (worker · console · tests)
pnpm test                       # every lane: unit (node), workers (workerd, the BUILT worker), e2e (one real worker), bench
pnpm e2e                        # the wire lane alone, against a local worker built by `vite build`
WORKER_BASE_URL=https://project-worker.iterate.workers.dev ADMIN_API_SECRET=… pnpm e2e   # the proof that counts
pnpm run deploy                 # vite build, then wrangler deploy --config dist/server/wrangler.json
```
