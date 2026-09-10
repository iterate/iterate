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
| `APP_CONFIG_SESSION_SECRET`                                         | yes      | signs the control plane's login cookie (secret)                                              |
| `APP_CONFIG_ADMIN_API_SECRET`                                       | yes      | the admin secret: `authenticate({ type: "admin-secret" })`, the lanes' admin bearer (secret) |
| `APP_CONFIG_PROJECT_TOKEN_SECRET`                                   | yes      | signs project tokens (`mintToken`, the console's project links) (secret)                     |
| `APP_CONFIG_PROJECT_HOSTNAME_BASE`                                  | no       | the base project hosts hang under; blank ⇒ no project-host ingress                           |
| `APP_CONFIG_ARTIFACTS_ACCOUNT_ID`, `APP_CONFIG_ARTIFACTS_NAMESPACE` | no       | `itx.repos`' git remotes                                                                     |

## The console

`src/routes/**` is a TanStack Start app, apps/auth's shape without Tailwind or a query client: four
file routes — `login.tsx` (`/login`: the email form; "continue as / switch account" with a session),
`_auth.tsx` (no session ⇒ `/login?next=`), `_auth/index.tsx` (`/`: the account page — orgs, projects
with an `open` link per host, create a project, log out) and `_auth/authorize.tsx` (`/authorize`:
the OAuth consent and THE PROJECT SELECTION) — plus `router.tsx`, the checked-in `routeTree.gen.ts`
(`pnpm routes:generate`; `pnpm routes:check` is part of `typecheck`) and one stylesheet,
`console.css`. Every route reads and acts through its own `createServerFn`s, which call the console
half of `src/control-plane.ts` (`signIn`, `accountOf`, `createProjectFor`, `consentOf`,
`approveConsent`) with the worker's env and the request as `context` (`src/routes/-console-context.ts`).
Beside the server functions, the same four actions are plain form POSTs for a script or a test —
`POST /login`, `/logout`, `/projects`, `/authorize` (`consoleDoor`) — every POST refused with 403
from a foreign `Origin`, every page `Cache-Control: no-store`.

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
