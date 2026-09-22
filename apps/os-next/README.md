# os-next — the clean-room platform, ONE worker

One Cloudflare Worker, one package: `src/worker.ts` is the stateless edge (capnweb at `/api`;
project-host ingress — `<app>--<project>.<base>`, `<app>.<project>.<base>`, the apex
`<project>.<base>` — the one HTTP way into a project) with
the control plane in-process as its catch-all (`src/{api,oauth,directory,mcp,issuer-pages}.ts`: OAuth AS + a D1 directory +
`/mcp`, the ONE MCP server for every project + the issuer's server half) and THE ISSUER'S TWO PAGES —
`/login` and the `/oauth2/auth` consent, files in `public/` the assets binding serves (no framework, no
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

An MCP client connects to `https://mcp.iterate2.com/` in production, or `/mcp` on a deployment
without a dedicated MCP origin. OAuth consent selects the projects the token may reach. The server
exposes one tool, `run({ project?, script })`: a JavaScript function, `async (itx) => …`, evaluated
with the selected project's root handle at `/`. Requests and settlements are recorded on the root
log with the caller's principal and grant. `project` may be omitted when the token reaches exactly
one project; an admin bearer always requires it.

Start with `async (itx) => ({ identity: await itx.whoami(), capabilities: await itx.rewriteRules.list() })`.
Read the config repo through `itx.repos.get("/repos/config")`; inspect its `AGENTS.md` when present.
A config-repo commit publishes the website. [Working MCP examples](e2e/mcp-project-root.e2e.test.ts)
show reads, commits and verification through the real endpoint. The tool description links their
[public raw source](https://raw.githubusercontent.com/iterate/iterate/main/apps/os-next/e2e/mcp-project-root.e2e.test.ts).
The `<codemode>` response format in `../agents/runtime/system-prompt.ts` belongs to the optional agents app;
MCP accepts the function text in `script`.

## Read next

- [Project creation design](docs/project-creation.md) — durable bootstrap, explicit repo/worker specs, and readiness before activation

- [Scheduled appends](docs/scheduled-appends.md) — durable deadlines for userspace facets, cancellation, and executable examples

- `LAYERS.md` — the layer map
- [Archived experiments](../../docs/archived-experiments.md) — the single backup of retired implementations and research

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
    cloudflare: { clientId: "…", clientSecret: "…" },
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
| `os.iterate2.com`                | THE HEADLESS PLATFORM — the issuer: `/login`, the `/oauth2/auth` consent, `/oauth2/*`, `/.well-known/*`, `/api` for bearers                                                                                                                       | the platform — this worker; the one origin that is cryptographically load-bearing (the OAuth issuer identifier, the `__Host-` cookie, the resource tokens are bound to) |
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
Both are files in `public/` (`login.html`, `oauth2/auth.html`, `issuer.css`, a script each, `_headers`
for their CSP), served by the assets binding. The sign-in page's script asks `/login.json`
(`issuer-pages.ts`) what to show and signs in with plain form posts to `/login`. The consent page is
a capnweb client of `/api` like any app — `public/capnweb.js`, the fork's browser bundle copied
beside it by `scripts/build.ts`, one WebSocket the session cookie rides in on: `consent.describe`
for what to show, `createOrg` and `projects.create` for a project made on the spot,
`consent.approve` for the client's redirect; the worker only gates the page.
Consent has two steps: choose or create projects, then review permissions and authorize.
All current and future projects are selected by default for clients that are not bound to one project.
Editing the project selection preserves the optional permissions already chosen. Consent is task-based: an app asks for
scopes (`iterate`; `account` for sessions and personal access tokens; `organizations:write` to create
organizations), the person may untick every one but `iterate`, and the grant carries what stayed
ticked — an app reads `session.info().scopes` and offers a step-up link for what it lacks. Everything
else — the dash (sessions, projects, organizations), agents, notes — is an app on its own origin holding
an OAuth grant (`kind: "app"`); only the issuer's own grant (`kind: "issuer"`) can approve consent.

Google and Cloudflare login prove identity to our issuer. Each callback establishes one ordinary, revocable
issuer grant through the same `BrowserSession` used by other apps. There is no separate
identity cookie. The `/login` page asks `/login.json` which mechanisms this deployment offers and
signs in with plain form posts to `/login`.

When email codes are enabled, the page starts with an email field and **Send me a code**.
**Use password instead** appears only when password sign-in is also configured; switching
methods preserves the email, and a rejected password keeps that method selected for retry.
Configured OAuth providers remain directly available, including on the code-entry step.

Email sign-in is a code: `POST /login` with an email mails a six-digit code through the
`EMAIL` binding (Cloudflare Email Sending, from `login.emailCode.from`; `src/password-and-code-sign-in.ts`),
good for ten minutes and five tries, and the page's code step posts it back; the reserved test
domains (`example.com`, `.test`, …) are never mailed. Password sign-in is `login.password`: one
global password, and the email typed beside it is the name tag — how a self-host signs in, and how
the specs and the e2e lane sign in on every deployment. Google and Cloudflare are each offered wherever their client is configured.

Cloudflare uses our own confidential OAuth client and Authorization Code with PKCE. Register
`<urls.os>/.auth/identity/cloudflare/callback` as an exact redirect URI. Cloudflare's client
configuration needs `response_types: ["code", "id_token"]` to enable `openid`; the actual login
request remains `response_type=code` and asks only for `openid user-details.read`. Cloudflare
rejects the separate `email`/`profile` scopes but returns `email` and `email_verified` in the
signed ID token with these scopes (verified against the live dev/preview client on 2026-09-22).
Both providers require verified email and validated signature, issuer, audience, state and nonce.
Identities are keyed by provider and subject; a first verified login can link to an existing user
by email, with only one subject per provider per user. Existing Google links migrate at boot.
Login does not retain Cloudflare API tokens or request deployment permissions.

Doppler `project-worker/prd` and `project-worker/preview` store `login.cloudflare` alongside Google
inside `APP_CONFIG`; its `clientSecret` references `APP_CONFIG_LOGIN__CLOUDFLARE__CLIENT_SECRET`.
The public client ID is in that same object, matching the existing Google configuration.
Self-hosters must use their own OAuth client; an Iterate-owned client secret must not be
shipped to customer-controlled Workers. The two Iterate clients are currently private, so
only members of their respective parent Cloudflare accounts can authorize them.

Only that issuer grant receives `session.consent`. The `/oauth2/auth` page can create an
organization and project through `session.createOrg` and `session.projects.create`, then
approve the pending client's access without leaving the flow — over `/api`, as any client would. Other apps may request account
permission through explicit consent, but cannot approve grants. All apps use the same
`/.auth/*` adapter, opaque HttpOnly cookie, public token exchange and `/api` proxy.

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

## Previews — one per pull request

Every PR that touches os-next gets its own preview of the worker on Cloudflare Worker Previews
(`wrangler preview`, private beta), the way [cloudflare/cloudflare-os](https://github.com/cloudflare/cloudflare-os)
previews itself: a preview named `pr<n>-<branch slug>` is a branch of the parent worker
`os-next-preview` (`envs.ts` `osNextEnvs.preview`; nothing reads its data) with Durable Object namespaces,
KV, R2, D1 and an Artifacts namespace of its own (all deleted with it), at `https://pr<n>-<slug>-os-next-preview.iterate-dev-preview.workers.dev`.
`.depot/workflows/preview-os-next.yml` deploys it on every push, runs `pnpm e2e` against it, writes the
URL and the operations below into the PR body, deletes it when the PR closes, and sweeps nightly.
Previews live on workers.dev and have no project hosts; the e2e rows that need one skip.

`scripts/preview.ts` is the whole thing (run in this directory, under the parent's Doppler config):

```bash
doppler run --project project-worker --config preview -- pnpm preview deploy --pr 123 --name my-branch
doppler run --project project-worker --config preview -- pnpm preview e2e    --pr 123 --name my-branch
doppler run --project project-worker --config preview -- pnpm preview reset  --pr 123 --name my-branch   # destroy, then deploy from scratch
doppler run --project project-worker --config preview -- pnpm preview delete --pr 123 --name my-branch
doppler run --project project-worker --config preview -- pnpm preview sweep
```

The apps on top — dash, agents, notes, voice — are OAuth clients of the platform and nothing else, so
each is previewed the same way from its own parent (`dash-preview` and so on, `envs.ts`) under the same
name, with the PR's os-next preview as its issuer: `https://pr<n>-<slug>-dash-preview.iterate-dev-preview.workers.dev`.
cloudflare-os rebuilds and redeploys all eighteen of its workers every push; ours deploy only when their own
paths (or the SDK, the shared UI, `scripts/lib`, `envs.ts`) changed since the merge-base — `--apps all`
previews every one, `--apps none` skips them. The PR body lists whichever were deployed.

A push redeploys the preview in place and its data carries over; when anything about it is wrong —
a schema change the idempotent DDL cannot apply, a class renamed, state you want gone — `reset` is the
answer. The same operations run from CI as `depot ci dispatch ... --workflow preview-os-next.yml
--input pull-request-number=123 --input action=<deploy|reset|e2e|delete>`; the PR body lists them.
The wrangler that provisions KV and R2 per preview is the pkg.pr.new build of workers-sdk PR #14416,
installed into a tmpdir per run exactly as cloudflare-os does, until that ships.
