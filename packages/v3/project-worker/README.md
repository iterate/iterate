# project-worker — the clean-room platform, ONE worker

One Cloudflare Worker, one package: `src/worker.ts` is the stateless edge (capnweb at `/api`,
project-host ingress `<app>--<projectId>.<base>`, the fetch lane) with the control plane in-process
as its catch-all (`src/control-plane.ts`: OAuth AS + a D1 directory + `/mcp`, the ONE MCP server for
every project + the console);
`src/iterate-context-durable-object.ts` is THE CONTEXT — one Durable Object per `{ projectId, path }`
holding the event log, the core reduce, subscription delivery, the facets, the rpc-stub pagers and
the egress door. Everything a client does is one dotted expression on `itx`.

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
picks the projects the token may reach, and the tools are `whoami`, `list_projects`,
`create_project({ project })` and `itx.invoke({ project?, expression, args? })` — one expression,
evaluated through that project's context under the caller's principal. The admin secret and a
project's own secret (`/mcp?project=<id>`) are bearers on `/mcp` too.

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
| `APP_CONFIG_PROJECT_TOKEN_SECRET`                                   | no       | signs project tokens; blank ⇒ none verifies (secret)                                         |
| `APP_CONFIG_PROJECT_HOSTNAME_BASE`                                  | no       | the base project hosts hang under; blank ⇒ no project-host ingress                           |
| `APP_CONFIG_ARTIFACTS_ACCOUNT_ID`, `APP_CONFIG_ARTIFACTS_NAMESPACE` | no       | `itx.repos`' git remotes                                                                     |

## Run

```bash
pnpm test                       # every lane: unit (node), workers (workerd), e2e (one real worker), bench
pnpm e2e                        # the wire lane alone, against a local worker
WORKER_BASE_URL=https://project-worker.iterate.workers.dev ADMIN_API_SECRET=… pnpm e2e   # the proof that counts (plus PROJECT_TOKEN_SECRET for the token rows)
pnpm run typecheck && pnpm run deploy
```
