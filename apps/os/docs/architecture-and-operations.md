# Architecture And Operations

This document collects the operational details that should not live in the
short README.

## Runtime Shape

OS has no public product pages. Browser users without a Clerk session are sent
to `/sign-in`; signed-in users use Clerk organization context through
organization-scoped routes under `/orgs/:organizationSlug`.

The browser talks to `/api` over oRPC/OpenAPI. SSR uses the same typed router
through the in-process router client. The Worker entrypoint assembles request
context (`manifest`, `config`, `db`, `log`, Durable Object namespaces) and wraps
requests with the shared `withEvlog()` runtime logging helper.

Project-scoped oRPC procedures should stay thin. The app worker authenticates
the caller, resolves project slug or ID to the stable Project ID, checks project
access, and calls the Project Durable Object for lifecycle behavior. D1 tables
such as `projects` and ingress rules are queryable projections, not the
lifecycle authority.

## API And Routing

The main app routes are:

```text
/orgs/:organizationSlug/projects
/orgs/:organizationSlug/projects/:projectSlug
/orgs/:organizationSlug/projects/:projectSlug/codemode-sessions
/orgs/:organizationSlug/projects/:projectSlug/codemode-sessions/new
/orgs/:organizationSlug/projects/:projectSlug/streams
/orgs/:organizationSlug/projects/:projectSlug/streams/*
/orgs/:organizationSlug/projects/:projectSlug/settings
```

The project root redirects to `codemode-sessions`. The authenticated app root
redirects to `codemode-sessions/new` for the user's first available project.

Project-scoped oRPC procedures live under the singular `project` router. The
plural `projects` router is for collection operations such as listing and
creating projects. Project-scoped procedures accept `projectSlugOrId`; callers
may pass a globally unique slug for curlable requests or a stable Project ID.

Examples:

```text
os.projects.list()
os.projects.create(...)
os.project.get({ projectSlugOrId })
os.project.streams.list({ projectSlugOrId })
os.project.codemode.listSessions({ projectSlugOrId })
os.project.inboundMcpServer.listSessions({ projectSlugOrId })
```

REST/OpenAPI paths mirror the same project scope, for example
`/projects/{projectSlugOrId}/streams`.

## Project Ingress

OS classifies hostnames before TanStack Start and dashboard authentication:

```text
request hostname
  -> D1 exact-host ingress lookup
    -> ProjectIngressEntrypoint({ projectId }) -> ProjectDurableObject.ingressFetch()
    -> OS app fallback
```

`ProjectIngressEntrypoint` and `ProjectMcpServerEntrypoint` are named exports
from the main OS Worker. They receive stable `projectId` props. Slug-to-ID
resolution should happen before hot ingress, when project projections are
written.

Project-owned ingress mutations should go through the Project Durable Object.
The Durable Object records desired state locally and writes global D1 projection
rows for the hot Worker path. Durable Object SQLite and D1 are not one atomic
transaction, so repair/reconciliation should be explicit follow-up work.

## Streams

`StreamDurableObject` lives in `packages/shared/src/streams`. It knows about
`namespace` and `path`, not projects. OS uses the stable Project ID as the
stream namespace, which means OS stream paths are project-local:

```text
/codemode-sessions/<id>
/mcp-server-sessions/<id>
```

The Project Stream Explorer lives at:

```text
/orgs/:organizationSlug/projects/:projectSlug/streams
```

Detail pages are splat routes. `/streams/foo/bar` opens stream path `/foo/bar`
inside the project-bound namespace.

OS should deploy the shared stream Durable Object from the main worker script
and bind `STREAM` to that local namespace. Other apps may use cross-script
bindings to point at OS's stream namespace.

## Durable Object Utilities

Durable Objects should use the shared Iterate Durable Object base from
`@iterate-com/shared/durable-object-utils/iterate-durable-object` unless there
is a specific reason not to. That base composes the runtime core adapters,
lifecycle hooks, D1 object catalog projection, local SQLite inspector, and local
KV inspector.

The main Worker exposes public Durable Object utility routes for initialization,
inspection, listing, and repair. These are infrastructure routes, not TanStack
product routes.

Current direct debug fetch routes include:

```text
/__durable-objects/project/<name>/__outerbase
/__durable-objects/project/<name>/__kv
/__durable-objects/codemode-session/<name>/__outerbase
/__durable-objects/project-mcp-server-connection/<name>/__kv
/durable-objects/stream/...
```

## MCP Directionality

OS has two MCP flows:

- Inbound MCP: external MCP clients connect to a project MCP hostname. The
  request enters `ProjectMcpServerEntrypoint`, authenticates with an OS admin
  token or a Clerk user token, and delegates session state to
  `ProjectMcpServerConnection`.
- Outbound MCP: a codemode session uses an external MCP server as a Tool
  Provider. `OutboundMcpFromOurClientCapability` owns the client connection and
  exposes `executeCodemodeFunctionCall(...)`.

Keep these separate in naming and code. Inbound MCP may execute codemode, but it
is not itself a codemode Tool Provider.

Project MCP hostnames expose RFC 9728 protected-resource metadata at
`/.well-known/oauth-protected-resource`, pointing clients at Clerk as the
authorization server. The MCP entrypoint accepts Clerk OAuth access tokens for
OAuth MCP clients and Clerk session tokens for first-party/e2e clients. If a
Clerk token has no active organization claim, OS checks the user's Clerk
organization memberships before running the project access check.

## Codemode

Codemode executes JavaScript in isolated dynamic Worker sandboxes through oRPC
or MCP.

Primary surfaces:

- UI: project codemode session pages.
- oRPC: `project.codemode.createSession`,
  `project.codemode.executeScript`, and `project.streams` reads.
- MCP: `exec_js` on a project MCP route, such as
  `https://mcp__demo.iterate.app`.

Default providers are registered for every session. The important built-ins are
`ctx.fetch`, `ctx.console`, `ctx.streams`, worker AI examples, OpenAPI examples,
repo/workspace handles, `ctx.agents.create()` subagent handles, Slack Web API
calls, and oRPC discovery/execution examples.

The codemode oRPC provider exposes the real `os.project.*` subtree as
project-bound `ctx.os.*`. It injects only the stable Project ID as
`projectSlugOrId`, rejects caller-supplied `projectSlugOrId`, and strips that
field from generated codemode types/listings.

Slack and other event-mediated providers can append function-call completions
from outside the codemode processor. RPC providers return through
`executeCodemodeFunctionCall(...)`.

## Database

sqlfu is the database source of truth:

- `src/db/definitions.sql` declares the desired schema.
- `src/db/migrations/*.sql` is the migration history.
- `src/db/queries/*.sql` contains checked-in application queries.
- `src/db/queries/.generated` and `src/db/migrations/.generated` are generated
  by `pnpm sqlfu:generate`.

Use sqlfu for schema changes and migrations. Do not hand-write migration history
outside the sqlfu workflow.

Persisted records should make scope explicit with first-class columns. Common
scopes are Project, Clerk Organization, Clerk User, and Global. Do not hide
ownership or routing scope only inside JSON metadata or callable props.

## Runtime Config

Runtime config is built from optional base JSON in `APP_CONFIG` plus nested
`APP_CONFIG_*` overrides. Overrides use `__` as the nesting separator and are
converted to the schema's camelCase shape.

Examples:

```text
APP_CONFIG_BASE_URL=https://os.iterate.com
APP_CONFIG_CLERK__PUBLISHABLE_KEY=pk_test_...
APP_CONFIG_CLERK__SECRET_KEY=sk_test_...
APP_CONFIG_CLERK__JWT_KEY='-----BEGIN PUBLIC KEY-----...'
APP_CONFIG_PROJECT_HOSTNAME_BASES=["iterate.app"]
APP_CONFIG_LOGS__STDOUT_FORMAT=pretty
APP_CONFIG_SLACK_BOT_TOKEN=xoxb-...
APP_CONFIG_INTEGRATIONS__SLACK='{"oauthClientId":"123.456","oauthClientSecret":"...","webhookSigningSecret":"..."}'
APP_CONFIG_INTEGRATIONS__GOOGLE='{"oauthClientId":"...","oauthClientSecret":"..."}'
```

The final merged object must satisfy the app schema in `src/app.ts`.
Frontend-visible config is exposed through the typed
`__internal.publicConfig` oRPC procedure.

`integrations.slack` and `integrations.google` are Runtime Config, not
deployment config. They are supplied by Doppler as grouped JSON values so each
provider's OAuth client values are updated atomically. Local Docker/workerd runs
receive the same config through `doppler run`. Slack uses one OAuth client for
OS; the Slack team ID claimed during OAuth decides which project receives
signed Slack webhooks.

## Clerk

Clerk apps and Doppler config are managed by
`apps/os/scripts/sync-clerk-apps.ts`. Re-run it after changing the Clerk auth
shape so dev, preview, and production Doppler configs stay aligned with the
matching Clerk app and OAuth app.

Required setup:

1. Enable Organizations for the Clerk application.
2. Configure OS to require organization context and hide personal-account mode.
3. Store the publishable key, secret key, and JWT public key in OS runtime
   config.
4. Create a Clerk OAuth Application for OS MCP/CLI clients.
5. Keep MCP authorization project-scoped in OS app code; Clerk OAuth scopes
   should stay Clerk-supported scopes such as `openid`, `email`, and `profile`.

Useful first-party references:

- Clerk TanStack Start middleware:
  `https://clerk.com/docs/reference/tanstack-react-start/clerk-middleware`
- Clerk organization components:
  `https://clerk.com/docs/organizations/overview`
- Clerk OAuth token verification:
  `https://clerk.com/docs/guides/configure/auth-strategies/oauth/verify-oauth-tokens`
- Clerk request authentication and accepted token types:
  `https://clerk.com/docs/reference/backend/authenticate-request`
- Clerk test session-token flow:
  `https://clerk.com/docs/testing/overview`
- Clerk CLI:
  `https://clerk.com/docs/cli`

## Smoke Tests

Preview worker smoke:

```bash
doppler run --project os --config preview_2 -- pnpm e2e -t "OS preview smoke"
```

Full browser smoke with Clerk and `agent-browser`:

- [Preview Agent Browser Smoke](./preview-agent-browser-smoke.md)

Codemode MCP provider-stack smoke:

```bash
OS_E2E_MCP_URL=https://mcp__demo.iterate-preview-2.app \
doppler run --project os --config preview_2 -- pnpm e2e -t "project MCP exec_js"
```

The MCP smoke accepts either:

- `OS_E2E_MCP_BEARER_TOKEN`: an explicit Clerk OAuth access token or Clerk
  session token for a user whose Clerk organization has access to the project.
- `OS_E2E_ADMIN_API_SECRET`, `OS_ADMIN_API_SECRET`, or
  `APP_CONFIG_ADMIN_API_SECRET`: an OS admin token for deployment-level smoke
  tests that do not need user/project membership setup.

For browserless Clerk e2e, do not pass a Clerk Testing Token as the bearer
token. Clerk Testing Tokens are only bot-detection bypass tokens for Frontend
API requests. Create a Clerk user, create a session for that user, create a
session token from that session, and pass the returned session token as
`Authorization: Bearer <session_token>` through `OS_E2E_MCP_BEARER_TOKEN`.

When `APP_CONFIG_SLACK_BOT_TOKEN` is present in the test process, the codemode
MCP test discovers `#slack-agent-e2e-test` and includes a real
`ctx.slack.chat.postMessage(...)` call.
