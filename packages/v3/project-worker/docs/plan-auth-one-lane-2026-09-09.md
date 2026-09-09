# Auth: one login, every door through `authenticate(credentials)` (2026-09-09, revision 2)

Revision 2 folds in Jonas's seven annotations, the reading of apps/os and apps/auth, a read of
`@cloudflare/workers-oauth-provider`'s source, issues and PRs, Cloudflare's own MCP servers and the
2026-07-28 MCP authorization spec (the research report is in the session scratchpad; every claim
below that names a line or an issue number comes from it).

Decisions from the annotations, restated:

- No auth.iterate.com here. The clean room's own OAuth provider IS its identity provider, for good.
- The email input is the login page; Google lands on that same page later.
- Every MCP server — the platform's `/mcp` and a project's `itx.serveMcp()` mount — authenticates
  through that one login, AND accepts a project secret, like apps/os.
- Long-lived project secrets exist from day one: devices (the kit's ESP partition carries the
  project slug + the project API key) and headless apps authenticate AS the project.
- `open` mode goes. The e2e lane authenticates with an admin secret, like apps/os.
- Wherever a project is named, the field is `project`, typed `ProjectIdOrSlug`. (In this
  deployment a project's id IS its slug — one DNS-safe name stored once — so the type is one
  string and the rule is a rename.)

## 1. How the browser authenticates: `from-server-cookie`, the apps/os shape

The question was how a browser comes into possession of a credential to pass to
`authenticate(credentials)`, given that a browser cannot set headers on a WebSocket and any site can
open a WebSocket to our origin. apps/os's answer (`apps/os/src/auth.ts`, `apps/os/src/README.md`
"Connecting and authenticating") is the one Kenton's capnweb README recommends:

- The credential names WHERE the identity already is: `authenticate({ type: "from-server-cookie" })`.
  The browser sends no secret; the HttpOnly session cookie rode the WebSocket handshake
  automatically, and the server reads it there. The in-band call is the client's explicit request
  to use it — never implicit, so "no credentials" and "use my cookie" are different calls.
- The ONE guard that makes the ambient cookie safe: it is honoured only when the handshake's
  `Origin` header equals this origin, or is absent (a non-browser client). Eight lines
  (`apps/os/src/auth/operator-session.ts` `isSameOriginBrowserRequest`). Without it the cookie lane
  is cross-site request forgery over RPC; with it, it is fine.
- Pipelining holds: `api.authenticate({ type: "from-server-cookie" }).projects.get(project)` is one
  round trip.

The clean room does the cookie half today (`authenticate()` with no argument reads the control-plane
cookie off the upgrade request) and lacks both the named credential and the origin check.

## 2. The credential union — `/api`'s one door

```ts
type ProjectIdOrSlug = string;   // one DNS-safe name; the directory row, the DO name, the host label

authenticate(credentials:
  | { type: "from-server-cookie" }                                   // the browser: the login cookie on the handshake, same origin only
  | { type: "project-token"; token: string }                          // short-lived, ONE user on ONE project (a project host's cookie, a script's bearer)
  | { type: "project-secret"; project: ProjectIdOrSlug; secret: string }   // long-lived: the project ITSELF (devices, headless apps)
  | { type: "admin-secret"; secret: string }                          // the deployment's admin secret: the e2e lane, tooling; may reach any project
  | { type: "admin-secret"; secret: string; as: { sub: string; email: string } }  // impersonate: a user's session without a login (confinement tests)
): Session
```

Every lane maps onto the same union. A project host and the `/expression` lane read the same kinds
off a request: the project-session cookie ⇒ `project-token`, `Authorization: Bearer` ⇒ a project
token, a project secret, or (on an MCP mount) an OAuth access token — the door tries each verifier
in that order, a few lines each, no new mechanism.

## 3. The project secret

apps/os: every project is born with a readable secret at `/secrets/project-api-key`; the
`project-secret` lane resolves the slug, compares the candidate inside the Secret Durable Object
(constant time), and grants exactly that project — no user, no admin, no directory widening
(`apps/os/src/auth.ts:322-345`). The kit's provisioning partition carries `{ baseUrl, project slug,
project API key }` and firmware presents it (`apps/kit/README.md`).

Here: `itx.secrets` already exists (write-only, KV, the core catalog). The project secret is one
named entry, `project-api-key`, born with the project (minted in `projects.create`, ≈ 8 lines),
revealable ONCE through `projects.get(project).revealApiKey()` for a member, rotatable through
`itx.secrets.set`. Verification: a SHA-256 of the presented secret compared with the stored hash at
the door (KV get + constant-time compare, ≈ 15 lines). It is structurally never substituted into
egress (the catalog marks it). The principal it grants is `{ actor: "project:<project>" }`.

## 4. The project token and the project-host cookie (`/.itx/session`)

Two lanes serve a browser. The capnweb lane (`/api`) is §1. The OTHER lane is a project host serving
an app page — `itx.apps.<name>`, an ordinary HTTP GET, possibly a static page with no script — and
the only identity a browser attaches to a plain page load is a cookie. `/.itx/session?token=…&next=/`
on a project host verifies a project token for THAT project and sets it as a host-scoped HttpOnly
cookie; `?logout` clears it. It is apps/os's `iterate-project-auth` cookie (HS256, 15 minutes,
verified locally, one user on one project). It stays. What was missing is the minter:
`projects.get(project).mintToken({ ttlSeconds? })` for a member (≈ 25 lines); the console links a
project host through that door.

## 5. OAuth: the provider is the identity provider; every MCP host is its resource server

What the research found (0.10.3 source, `oauth-provider.ts`; cloudflare/mcp; the spec):

- **Multi-host is first-class.** `apiRoute: "/mcp"` matches on every hostname the worker serves;
  `tokenEndpoint` may be a full URL and the RFC 8414 `issuer` is always that endpoint's ORIGIN; the
  protected-resource metadata's `authorization_servers` derives from it. One instance, one issuer
  (`https://<platform host>`), tokens for many hosts.
- **Bind every token to its resource.** With `resourceMetadata.resource` unset, a client that omits
  RFC 8707 `resource` gets a token that works on EVERY host (0.10.1 #288, deliberate compat; the TS
  SDK omits it whenever PRM discovery fails). The fix is Cloudflare's own production shape
  (`cloudflare/mcp` `src/index.ts`): construct the provider PER REQUEST — the clean room already
  constructs it per request — with `resource` pinned to `${origin}/mcp` for every `/mcp` host and
  unset only on the AS endpoints (`/authorize`, `/oauth/*`). Then the provider, not app code,
  rejects unbound and cross-host tokens; PR #289 (the maintainer's 1.0 draft, "one authorization
  server for multiple MCP resources") makes exactly this native.
- **The project secret rides the sanctioned hook.** `resolveExternalToken({ token, request })`
  runs when the bearer is not a provider token; it returns `{ props, audience }` and the provider
  audience-checks it. Cloudflare's servers accept their API tokens this way (mcp-server-cloudflare
  PR #443). A platform-minted secret consumed at this resource is a first-party credential, not
  token passthrough.
- **Opaque tokens, not JWTs.** The provider's tokens are opaque (`{userId}:{grantId}:{secret}`,
  stored hashed in KV, props AES-GCM under a per-grant key). No shipped release issues JWTs (PR #292
  proposes them, unreviewed since 2026-08). Cloudflare Access is opaque by design. A second worker
  could already verify with `getOAuthApi(env).unwrapToken` over the shared KV. Follow the provider.
- **`/oauth/*` is naming, and the README's own shape** (`tokenEndpoint: '/oauth/token'`,
  `clientRegistrationEndpoint: '/oauth/register'`). The two `/.well-known/*` documents stay at the
  root by RFC and the issuer is always the bare origin; `/authorize` stays app-owned ("the provider
  is not an identity provider"). Keep `/login` beside it.
- **Registration:** CIMD on (`clientIdMetadataDocumentEnabled`, needs the
  `global_fetch_strictly_public` compat flag), DCR kept as the fallback (Cursor has no CIMD;
  removal from the spec is 2027 at the earliest). PKCE S256 only, RFC 9207 `iss` — the provider
  does all of it.
- **One consent per resource** is what the spec expects (credentials keyed by issuer + resource);
  "one login" is the cookie session on the platform host: the second consent is one click.

So a project's `itx.serveMcp()` mount on `mcp--<project>.<base>/mcp` is served THROUGH the provider
like `/mcp` is: an OAuth bearer ⇒ `ctx.props = { sub, email, project }`; a project secret ⇒
`resolveExternalToken` ⇒ `{ actor: "project:<project>" }`; none ⇒ the provider's 401 with
`WWW-Authenticate: Bearer resource_metadata="https://mcp--<p>.<base>/.well-known/oauth-protected-resource/mcp"`.
The consent page derives `props.project` from the request's `resource` host and refuses an
authorize with no `resource`. The email-mode serveMcp red pin closes by construction.

## 6. The console as a TanStack Start app, with project selection

Today the console is string-built HTML in `control-plane.ts` (login form, home, consent). apps/auth
is the clean template for what it becomes: a TanStack Start app served as static assets with
`run_worker_first: ["/api/*", "/oauth/*", "/mcp", "/expression*", "/.well-known/*"]`, the worker's
`fetch` falling through to the Start server entry for every other path; Vite with the Cloudflare
plugin for dev and build; the screens as file routes.

The screens, in apps/auth's order, sized from its routes:

| Route | Does | apps/auth | Here |
|---|---|---|---|
| `/login` | the email form now; Google beside it later; "continue as / switch account" inside an authorize flow (the `sig` param marks it) | 300 lines | ≈ 80 |
| `/consent` | "Allow <client> to use your account?" — approve / switch account | 225 | ≈ 60 |
| `/project-access` | THE PROJECT SELECTION at OAuth time: when the client asked for the `project` scope, the user picks which projects the token may reach; the choice narrows the token's `projects` claim / `project:<id>` scopes | 911 (a three-hop handoff through better-auth) | ≈ 120 — the provider hands `props` to `completeAuthorization` directly, so the selection is one form field |
| `/` | account page: projects list, create project, authorized clients | 178 + 290 | ≈ 100 |

Project selection, concretely: an MCP client requests `scope=project&resource=https://mcp--<p>.<base>/mcp`
— the resource already names ONE project, so the "selection" is a confirmation for a project host.
On the PLATFORM `/mcp` (the control plane's own tools) the page lists the user's projects and the
chosen ones ride in `props.projects`; the tools act only within them. Same page, two shapes.

Cost of the TanStack move: the Vite + Start + Cloudflare plugin toolchain (apps/auth's `vite.config.ts`,
≈ 40 lines) and `build-sdk.mjs` folding into it; the HTML builders in `control-plane.ts` (≈ 110
lines) replaced by routes (≈ 360). It also gives the demo page a home as a route instead of a
second esbuild. Net ≈ +250 lines and one toolchain; the design does not depend on it — the string
console can carry §1–§5 first.

## 7. The e2e lane

`APP_CONFIG_ADMIN_API_SECRET` (a wrangler secret; the lane's var). `authenticate({ type: "admin-secret",
secret })` ⇒ admin, any project; with `as` ⇒ that user, no login. `Authorization: Bearer <secret>`
on `/expression` and on a project host ⇒ the same. The e2e support's minted-token helper is
replaced by one line; the project-secret and OAuth rows mint through the real doors.

## 8. What changes, counted

| Change | Lines | Kind |
|---|---:|---|
| `open` mode: the type, the var, `ANONYMOUS`, the `/mcp` short-circuit, the seeded row, the branches | ≈ −60 | DELETE |
| `authenticate(credentials)` union; the origin check on `from-server-cookie`; the no-argument form gone | ≈ +30 / −10 | REPLACE |
| `project` : `ProjectIdOrSlug` everywhere a project is named (`projects.get`, tokens, the secret) | ±0 | RENAME |
| The project secret: born in `create`, `revealApiKey`, the hash compare at the doors, the catalog mark | ≈ +45 | ADD |
| `projects.get(project).mintToken` | ≈ +25 | ADD |
| The provider per request with `resource` pinned per host; project hosts routed through it for `/mcp`; `resolveExternalToken` for the secret; the consent reads `resource`; CIMD + the compat flag; `/oauth/*` names | ≈ +50 / −15 | ADD |
| The admin secret + impersonate; the e2e lane onto it | ≈ +35 / −10 | ADD |
| Tests: open-mode rows go; the serveMcp pin turns green; one row per door | ≈ +60 / −60 | |
| The TanStack console (§6) | ≈ +250 | later, separable |

Core (everything but §6): net ≈ +90 lines, one concept fewer, two holes closed (the ambient cookie
without an origin check; email-mode `serveMcp`), and the credential shapes production uses.

## 9. Order

1. `open` mode out; `authenticate(credentials)` with the union, the origin check and the admin
   secret; the `project` rename; the e2e lane onto the admin secret. One commit; the deployed proof
   needs the new wrangler secret first.
2. The project secret and `mintToken`; the kit-style device lane proven by an e2e row that presents
   the born key on a project host.
3. The provider per request, `/oauth/*`, project hosts through it, CIMD; the serveMcp pin flips.
4. The TanStack console with `/login`, `/consent`, `/project-access`, `/`.

## 10. Not copied, and why

- Minted forge-key sessions (`auth:mint`): the admin secret plus `as` covers every test need.
- JWT access tokens and JWKS: no shipped provider release issues them; one worker needs no
  offline verifier; `unwrapToken` over the shared KV serves a second worker if one arrives.
- A separate auth worker: this deployment is one worker and its own issuer; the seam is the
  issuer origin, one string.
- apps/auth's three-hop project-selection handoff: an artefact of better-auth's plugin having no
  channel from a page to token minting; the provider's `completeAuthorization({ props })` is that
  channel.
