# os-next — the clean-room platform, ONE worker

One Cloudflare Worker, one package: `src/worker.ts` is the stateless edge (capnweb at `/api`;
project-host ingress — `<app>--<project>.<base>`, `<app>.<project>.<base>`, the apex
`<project>.<base>` — the one HTTP way into a project) with
the control plane in-process as its catch-all (`src/control-plane.ts`: OAuth AS + a D1 directory +
`/mcp`, the ONE MCP server for every project + the issuer's server half) and THE ISSUER'S TWO PAGES —
`/login` and the `/authorize` consent, files in `public/` the assets binding serves (no framework, no
build), each asking its JSON sibling what to show — the consent's session built the way `/api` builds one;
`src/iterate-context-durable-object.ts` is THE CONTEXT — one Durable Object per `{ projectId, path }`
holding the event log, the core reduce, subscription delivery, the facets, the rpc-stub pagers and
the fetch door. Everything a client does is one dotted expression on `itx`.

```ts
using api = newWebSocketRpcSession("wss://<worker>/api"); // the client's only dependency: capnweb
const session = api.authenticate({ type: "from-server-cookie" }); // the issuer's login cookie rode the handshake
const itx = await session.projects.create({ project: "my-project" }); // → the project's root context
await itx.append({ type: "note", payload: { n: 1 } });
```

`authenticate(credentials)` takes one of two kinds (`src/session.ts` `SessionCredentials`):
`from-server-cookie` (the transport already carries a resolved OAuth grant — a browser's cookie on a
same-origin request, or an `Authorization: Bearer` access token) and `admin-secret` (every project;
with `as` a user's session without a login — the e2e project, tooling). OAuth grants are the ONE
credential for every other principal: a browser session, a connected app, and a PERSONAL ACCESS
TOKEN — `session.grants.mint({ name, projects })` on the dash's sessions page (apps/dash): one finite grant
(30 days, scoped to the projects named, shown once, revocable from `session.grants.list()`/`end`)
whose bearer opens `/api`, `/mcp` and a covered project host as the user.

An MCP client connects to `https://<worker>/mcp` through the same login: the OAuth 2.1 AS is the
worker itself (`/authorize`, `/oauth/token`, `/oauth/register`, `/.well-known/*`), the consent page
picks the projects the token may reach, and it exposes ONE tool, `run({ project?, script })`
— the text of `async (itx) => …` evaluated in that project's context under the caller's
principal (`run(script)` when the token reaches exactly one project). Whatever a caller might read —
who it is, which projects — is a one-line script; a project is created on the OS, in consent, or over `/api`. The
admin secret is a bearer on `/mcp` too (it reaches every project, so `run` must name one).

## Read next

- [Scheduled appends](docs/scheduled-appends.md) — durable deadlines for userspace facets, cancellation, and executable examples

- `docs/itx-surface-as-built.md` — every signature, transcribed from source (start here)
- `docs/clean-room-api-walkthrough.md` — the long-form walkthrough, module by module
- `docs/design-onion-subscriptions-processors.md` — the design of record for subscriptions + processors
- `LAYERS.md` — the layer map (the build log that used to sit beside it lives on the `backup/kernel-wayfinder-2026-07-30-presquash-*` branch)
- [Archived experiments](../../../docs/archived-experiments.md) — the single backup of retired implementations and research
- [Design research](docs/research/README.md) — OAuth research, implementation reviews, and deployment evidence
- [Archived history](docs/history/README.md) — earlier plans, reviews, proposals, and logs on GitHub

## Configuration

`APP_CONFIG_*` vars, parsed once per isolate by `src/app-config.ts` `parseAppConfig` (an unknown
one is warned about at boot and ignored). The two secrets are wrangler secrets on a deployment
(`wrangler secret put <name>`), plain vars in the test configs:

| Var                                                                 | Required | What                                                                                         |
| ------------------------------------------------------------------- | -------- | -------------------------------------------------------------------------------------------- |
| `APP_CONFIG_ENVIRONMENT_NAME`                                       | yes      | the deployment's name at `/version` ("poc", "test", "e2e")                                   |
| `APP_CONFIG_SESSION_SECRET`                                         | yes      | signs the ten-minute Google login flow (secret)                                              |
| `APP_CONFIG_ADMIN_API_SECRET`                                       | yes      | the admin secret: `authenticate({ type: "admin-secret" })`, the lanes' admin bearer (secret) |
| `APP_CONFIG_SECRETS_KEY`                                            | yes      | encrypts project secrets' material at rest (`secret-at-rest.ts`; secret)                     |
| `APP_CONFIG_SECRETS_KEY_PREVIOUS`                                   | no       | the key before a rotation, decrypt-only; records are rewritten under the current key as read |
| `APP_CONFIG_PROJECT_HOSTNAME_BASE`                                  | no       | the base project hosts hang under; blank ⇒ no project-host ingress                           |
| `APP_CONFIG_TEST_EMAIL_LOGIN`                                       | no       | `true` permits unverified email sign-in; disabled remotely by default                        |
| `APP_CONFIG_ARTIFACTS_ACCOUNT_ID`, `APP_CONFIG_ARTIFACTS_NAMESPACE` | no       | the git remotes `itx.cfArtifacts` names for the repo facet                                   |

## Hostnames — the issuer, the OS, the projects

| Origin              | What answers                                                                                                                                                                                                                         | Whose                                                                                                                                                                   |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `os.iterate2.com`   | THE HEADLESS PLATFORM — the issuer: `/login`, the `/authorize` consent, `/oauth/*`, `/.well-known/*`, `/api` for bearers                                                                                                             | the platform — this worker; the one origin that is cryptographically load-bearing (the OAuth issuer identifier, the `__Host-` cookie, the resource tokens are bound to) |
| `mcp.iterate2.com`  | the ONE MCP server, a door beside `/api`                                                                                                                                                                                             | the platform — this worker                                                                                                                                              |
| `*.iterate2.app`    | project hosts: `<app>--<project>`, `<app>.<project>`, the apex `<project>` (the config worker's `fetch`)                                                                                                                             | userspace                                                                                                                                                               |
| `iterate2.com`      | the `iterate` project's apex — its config worker's `fetch`, through the custom-hostname door (`APP_CONFIG_PROJECT_CUSTOM_HOSTNAMES`, envs.ts `projectCustomHostnames`)                                                               | userspace                                                                                                                                                               |
| `dash.iterate2.com` | THE DASH — the fat first-party app (apps/dash: sessions and personal access tokens, projects and organizations), an ordinary OAuth client of the platform; agents, notes and voice are apps of the same shape on workers.dev origins | an app; anyone could ship another                                                                                                                                       |

The platform serves two pages and nothing else a person looks at: sign-in, because the session
cookie is the issuer origin's, and consent, because the authorization server is the one that asks.
Both are files in `public/` (`login.html`, `authorize.html`, `issuer.css`, a script each, `_headers`
for their CSP), served by the assets binding; each page's script asks its JSON sibling
(`/login.json`, `/authorize.json` — `control-plane.ts`) what to show, and the consent page posts its
actions — approve, create an organization, create a project — to `/authorize`. The session that
answers is built in the worker the way `/api` builds one. Consent is task-based: an app asks for
scopes (`iterate`; `account` for sessions and personal access tokens; `organizations:write` to create
organizations), the person may untick every one but `iterate`, and the grant carries what stayed
ticked — an app reads `session.info().scopes` and offers a step-up link for what it lacks. Everything
else — the dash (sessions, projects, organizations), agents, notes — is an app on its own origin holding
an OAuth grant (`kind: "app"`); only the issuer's own grant (`kind: "issuer"`) can approve consent. The
dashboard component and loader are also used verbatim by the independently hosted Notes app.

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

See [the current OAuth design](docs/unified-oauth-architecture.md) for boundaries,
revocation and the deferred impersonation design. Dated design and review docs under `docs/`
may still describe the pre-unification project credentials; they are history, not the public
authorization contract.

## Build, run, deploy

wrangler bundles the worker itself from `src/worker.ts` — `wrangler dev`, `wrangler deploy`, the e2e
harness and the workers test lane all start there. THE BUILD (`scripts/build.ts`, one esbuild script,
about a second) writes what the worker cannot import from source: `wrangler.jsonc` from the root
`envs.ts` and `src/generated/*.js` (the injected processor SDK's text, the presence fixture's source —
their `.d.ts` siblings are committed, so `tsc` and knip need no build). The issuer's pages need no
build at all. Every lane runs the build first.

```bash
pnpm dev -- --port 8788         # the build, the directory schema into the local D1, wrangler dev on
                                # wrangler.jsonc (project hosts under `<project>.localhost:8788`;
                                # dev values for the secrets — scripts/dev.ts)
pnpm build                      # scripts/build.ts: wrangler.jsonc + src/generated/*.js
pnpm run typecheck              # the three tsconfigs (worker · tests · scripts)
pnpm test                       # every lane: unit (node), workers (workerd, src/worker.ts), e2e (one real worker), bench
pnpm e2e                        # the wire lane alone, against a local worker the harness bundles from src
WORKER_BASE_URL=https://os.iterate2.com ADMIN_API_SECRET=… pnpm e2e   # the proof that counts
pnpm run deploy                 # the build, then wrangler deploy --config wrangler.jsonc --env <name>
```
