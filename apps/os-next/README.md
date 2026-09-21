# os-next — the clean-room platform, ONE worker

One Cloudflare Worker, one package: `src/worker.ts` is the stateless edge (capnweb at `/api`;
project-host ingress — `<app>--<project>.<base>`, `<app>.<project>.<base>`, the apex
`<project>.<base>` — the one HTTP way into a project) with
the control plane in-process as its catch-all (`src/control-plane.ts`: OAuth AS + a D1 directory +
`/mcp`, the ONE MCP server for every project + the issuer's server half) and THE ISSUER'S TWO PAGES —
`/login` and the `/authorize` consent, files in `public/` the assets binding serves (no framework, no
build): sign-in asks `/login.json` what to show and posts plain forms; consent is a capnweb client of `/api`;
`src/iterate-context-durable-object.ts` is THE CONTEXT — one Durable Object per `{ projectId, path }`
holding the event log, the core reduce, subscription delivery, the facets, the rpc-stub pagers and
the fetch door. Everything a client does is one dotted expression on `itx`.

```ts
using api = newWebSocketRpcSession("wss://<worker>/api"); // the client's only dependency: capnweb
const session = api.authenticate({ type: "from-server-cookie" }); // the issuer's login cookie rode the handshake
const itx = await session.projects.create({ project: "my-project" }); // → the project's root context, its creation saga on the log
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

- [Project creation design](docs/project-creation.md) — durable bootstrap, explicit repo/worker specs, and readiness before activation

- [Scheduled appends](docs/scheduled-appends.md) — durable deadlines for userspace facets, cancellation, and executable examples

- `docs/itx-surface-as-built.md` — every signature, transcribed from source (start here)
- `docs/clean-room-api-walkthrough.md` — the long-form walkthrough, module by module
- `docs/design-onion-subscriptions-processors.md` — the design of record for subscriptions + processors
- `LAYERS.md` — the layer map (the build log that used to sit beside it lives on the `backup/kernel-wayfinder-2026-07-30-presquash-*` branch)
- [Archived experiments](../../../docs/archived-experiments.md) — the single backup of retired implementations and research
- [Design research](docs/research/README.md) — OAuth research, implementation reviews, and deployment evidence
- [Archived history](docs/history/README.md) — earlier plans, reviews, proposals, and logs on GitHub

## Configuration

ONE JSON object per deployment, the `APP_CONFIG` Worker secret, parsed once per isolate by
`src/app-config.ts` `parseAppConfig` (every key documented there; an unknown one is warned about at
boot and dropped). Any key can also be set alone as a var, the path joined by `__`
(`APP_CONFIG_URLS__OS`, `APP_CONFIG_SECRETS__KEY`): the generated wrangler config writes a
deployment's `urls` that way from `envs.ts`, and `secrets.key` stands alone as its own secret so it
can rotate with `previousKey` beside it. A self-host sets the object and the key
([SELF-HOSTING.md](SELF-HOSTING.md)).

```js
{
  urls: {
    os: "https://os.iterate2.com",       // the issuer; unset ⇒ each request's own origin
    mcp: "https://mcp.iterate2.com",     // unset ⇒ /mcp on urls.os
    dash: "https://dash.iterate2.com",   // the landing page's "Launch dash"; unset ⇒ no link
    ingressRouting: { type: "subdomains", hostname: "iterate2.app" },   // or { type: "paths" }; unset ⇒ no ingress
    temporaryCustomHostnames: { "iterate2.com": "iterate" },            // a hostname that IS a project's apex
  },
  login: {                                              // each mechanism on iff present; none ⇒ refuses to boot
    password: "…",                                      // secret · anyone who knows it signs in as the email they type
    emailCode: { from: "iterate <login@iterate2.com>" },  // a mailed six-digit code · Email Sending on that domain
    google: { clientId: "…", clientSecret: "…" },
  },
  secrets: {
    key: "…",            // THE key: project secrets at rest, and the session-signing secret derives from it
    previousKey: "…",    // only mid-rotation
    adminBearer: "…",    // optional · the operator door: every project, `run` on /mcp, the specs
  },
}
```

## Hostnames — the issuer, the OS, the projects

| Origin                           | What answers                                                                                                                                                                                                                                      | Whose                                                                                                                                                                   |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `os.iterate2.com`                | THE HEADLESS PLATFORM — the issuer: `/login`, the `/authorize` consent, `/oauth/*`, `/.well-known/*`, `/api` for bearers                                                                                                                          | the platform — this worker; the one origin that is cryptographically load-bearing (the OAuth issuer identifier, the `__Host-` cookie, the resource tokens are bound to) |
| `mcp.iterate2.com`               | the ONE MCP server, a door beside `/api`                                                                                                                                                                                                          | the platform — this worker                                                                                                                                              |
| `*.iterate2.app`                 | project hosts: `<app>--<project>`, `<app>.<project>`, the apex `<project>` (the config worker's `fetch`)                                                                                                                                          | userspace                                                                                                                                                               |
| `iterate2.com`                   | the `iterate` project's apex — its config worker's `fetch`, through the custom-hostname door (`urls.temporaryCustomHostnames`, envs.ts)                                                                                                           | userspace                                                                                                                                                               |
| `dash.iterate2.com`              | THE DASH — the fat first-party app (apps/dash: sessions and personal access tokens, projects and organizations), an ordinary OAuth client of the platform; agents, notes and voice are apps of the same shape on workers.dev origins              | an app; anyone could ship another                                                                                                                                       |
| `<worker>.<account>.workers.dev` | A SELF-HOST (SELF-HOSTING.md): the same worker on ONE origin — the issuer, `/api`, `/mcp`, and every project under `/projects/<slug>/<app>/…` (`urls.ingressRouting: { type: "paths" }`; the apex at `/projects/<slug>/`; every answer sandboxed) | whoever deployed it                                                                                                                                                     |

The platform serves two pages and nothing else a person looks at: sign-in, because the session
cookie is the issuer origin's, and consent, because the authorization server is the one that asks.
(Beside them, two files for machines and their operators: `/` says the origin is headless and where the
dash is, and `/setup-prompt.md` is the prompt an agent follows to deploy a platform of its own —
`SELF-HOSTING.md`'s recipe.)
Both are files in `public/` (`login.html`, `authorize.html`, `issuer.css`, a script each, `_headers`
for their CSP), served by the assets binding. The sign-in page's script asks `/login.json`
(`control-plane.ts`) what to show and signs in with plain form posts to `/login`. The consent page is
a capnweb client of `/api` like any app — `public/capnweb.js`, the fork's browser bundle copied
beside it by `scripts/build.ts`, one WebSocket the session cookie rides in on: `consent.describe`
for what to show, `createOrg` and `projects.create` for a project made on the spot,
`consent.approve` for the client's redirect; the worker only gates the page. Consent is task-based: an app asks for
scopes (`iterate`; `account` for sessions and personal access tokens; `organizations:write` to create
organizations), the person may untick every one but `iterate`, and the grant carries what stayed
ticked — an app reads `session.info().scopes` and offers a step-up link for what it lacks. Everything
else — the dash (sessions, projects, organizations), agents, notes — is an app on its own origin holding
an OAuth grant (`kind: "app"`); only the issuer's own grant (`kind: "issuer"`) can approve consent.

Google login proves identity to our issuer. Its callback establishes one ordinary, revocable
issuer grant through the same `BrowserSession` used by other apps. There is no separate
identity cookie. The `/login` page asks `/login.json` which mechanisms this deployment offers and
signs in with plain form posts to `/login`.

Email sign-in is a code: `POST /login` with an email mails a six-digit code through the
`EMAIL` binding (Cloudflare Email Sending, from `login.emailCode.from`; `src/login-code.ts`),
good for ten minutes and five tries, and the page's code step posts it back; the reserved test
domains (`example.com`, `.test`, …) are never mailed. Password sign-in is `login.password`: one
global password, and the email typed beside it is the name tag — how a self-host signs in, and how
the specs and the e2e lane sign in on every deployment. Google is offered wherever it is configured.

Only that issuer grant receives `session.consent`. The `/authorize` page can create an
organization and project through `session.createOrg` and `session.projects.create`, then
approve the pending client's access without leaving the flow — over `/api`, as any client would. Other apps may request account
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
`envs.ts`, `wrangler.self-host.jsonc` (the same bindings with no ids — [SELF-HOSTING.md](SELF-HOSTING.md))
and `src/generated/*.js` (the injected processor SDK's text, the presence fixture's source —
their `.d.ts` siblings are committed, so `tsc` and knip need no build). The issuer's pages need no
build at all. Every lane runs the build first.

```bash
pnpm dev -- --port 8788         # the build, then wrangler dev on wrangler.jsonc (project hosts under
                                # `<project>.localhost:8788`; the password `dev` — scripts/dev.ts; the
                                # worker applies the directory schema to the local D1 at boot)
pnpm build                      # scripts/build.ts: wrangler.jsonc + wrangler.self-host.jsonc + src/generated/*.js
pnpm run typecheck              # the three tsconfigs (worker · tests · scripts)
pnpm test                       # every lane: unit (node), workers (workerd, src/worker.ts), e2e (one real worker), bench
pnpm e2e                        # the wire lane alone, against a local worker the harness bundles from src
WORKER_BASE_URL=https://os.iterate2.com ADMIN_API_SECRET=… LOGIN_PASSWORD=… pnpm e2e   # the proof that counts
pnpm run deploy                 # the build, then wrangler deploy --config wrangler.jsonc --env <name>
```
