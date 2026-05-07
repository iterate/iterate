# Architecture And Operations

This document collects the operational details that should not live in the
short README.

## Runtime Shape

OS2 has no public product pages. Browser users without a Clerk session are sent
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

The project root redirects to `codemode-sessions`. Older `run-code` links should
redirect to `codemode-sessions/new`.

Project-scoped oRPC procedures live under the `projects` router. For example,
streams are exposed as `projects.streams` and the REST/OpenAPI paths are nested
under `/projects/{projectId}/streams`.

## Project Ingress

OS2 classifies hostnames before TanStack Start and dashboard authentication:

```text
request hostname
  -> D1 exact-host ingress lookup
    -> ProjectIngressEntrypoint({ projectId }) -> ProjectDurableObject.ingressFetch()
    -> OS2 app fallback
```

`ProjectIngressEntrypoint` and `ProjectMcpServerEntrypoint` are named exports
from the main OS2 Worker. They receive stable `projectId` props. Slug-to-ID
resolution should happen before hot ingress, when project projections are
written.

Project-owned ingress mutations should go through the Project Durable Object.
The Durable Object records desired state locally and writes global D1 projection
rows for the hot Worker path. Durable Object SQLite and D1 are not one atomic
transaction, so repair/reconciliation should be explicit follow-up work.

## Streams

`StreamDurableObject` lives in `packages/shared/src/streams`. It knows about
`namespace` and `path`, not projects. OS2 uses the stable Project ID as the
stream namespace, which means OS2 stream paths are project-local:

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

OS2 should deploy the shared stream Durable Object from the main worker script
and bind `STREAM` to that local namespace. Other apps may use cross-script
bindings to point at OS2's stream namespace.

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

OS2 has two MCP flows:

- Inbound MCP: external MCP clients connect to a project MCP hostname. The
  request enters `ProjectMcpServerEntrypoint`, authenticates with Clerk OAuth,
  and delegates session state to `ProjectMcpServerConnection`.
- Outbound MCP: a codemode session uses an external MCP server as a Tool
  Provider. `OutboundMcpFromOurClientCapability` owns the client connection and
  exposes `executeCodemodeFunctionCall(...)`.

Keep these separate in naming and code. Inbound MCP may execute codemode, but it
is not itself a codemode Tool Provider.

Project MCP hostnames expose RFC 9728 protected-resource metadata at
`/.well-known/oauth-protected-resource`, pointing clients at Clerk as the
authorization server. The MCP entrypoint verifies Clerk-issued OAuth bearer
tokens before it passes identity props to the MCP session Durable Object.

## Codemode

Codemode executes JavaScript in isolated dynamic Worker sandboxes through oRPC
or MCP.

Primary surfaces:

- UI: project codemode session pages.
- oRPC: `codemode.createSession`, `codemode.executeScript`, and stream reads.
- MCP: `run_code` on a project MCP route, such as
  `https://mcp__demo.iterate2.app`.

Default providers are registered for every session. The important built-ins are
`ctx.fetch`, `ctx.console`, `ctx.streams`, worker AI examples, OpenAPI examples,
repo/workspace handles, subagent handles, and oRPC discovery/execution examples.

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
APP_CONFIG_BASE_URL=https://os.iterate2.com
APP_CONFIG_CLERK__PUBLISHABLE_KEY=pk_test_...
APP_CONFIG_CLERK__SECRET_KEY=sk_test_...
APP_CONFIG_CLERK__JWT_KEY='-----BEGIN PUBLIC KEY-----...'
APP_CONFIG_PROJECT_HOSTNAME_BASES=["iterate2.app"]
APP_CONFIG_LOGS__STDOUT_FORMAT=pretty
APP_CONFIG_SLACK_BOT_TOKEN=xoxb-...
```

The final merged object must satisfy the app schema in `src/app.ts`.
Frontend-visible config is exposed through the typed
`__internal.publicConfig` oRPC procedure.

## Clerk

Clerk apps and Doppler config are managed by
`apps/os2/scripts/sync-clerk-apps.ts`. Re-run it after changing the Clerk auth
shape so dev, preview, and production Doppler configs stay aligned with the
matching Clerk app and OAuth app.

Required setup:

1. Enable Organizations for the Clerk application.
2. Configure OS2 to require organization context and hide personal-account mode.
3. Store the publishable key, secret key, and JWT public key in OS2 runtime
   config.
4. Create a Clerk OAuth Application for OS2 MCP/CLI clients.
5. Keep MCP authorization project-scoped in OS2 app code; Clerk OAuth scopes
   should stay Clerk-supported scopes such as `openid`, `email`, and `profile`.

Useful first-party references:

- Clerk TanStack Start middleware:
  `https://clerk.com/docs/reference/tanstack-react-start/clerk-middleware`
- Clerk organization components:
  `https://clerk.com/docs/organizations/overview`
- Clerk OAuth token verification:
  `https://clerk.com/docs/guides/configure/auth-strategies/oauth/verify-oauth-tokens`
- Clerk CLI:
  `https://clerk.com/docs/cli`

## Smoke Tests

Preview worker smoke:

```bash
OS2_BASE_URL=https://os2.iterate-preview-2.com \
doppler run --project os2 --config preview_2 -- pnpm test:e2e:preview
```

Full browser smoke with Clerk and `agent-browser`:

- [Preview Agent Browser Smoke](./preview-agent-browser-smoke.md)

Codemode MCP provider-stack smoke:

```bash
OS2_E2E_MCP_URL=https://mcp__demo.iterate-preview-2.app \
OS2_E2E_MCP_BEARER_TOKEN="$ADMIN_OR_MCP_ACCESS_TOKEN" \
pnpm test:e2e:codemode-mcp
```

Set `OS2_E2E_SLACK_CHANNEL_ID=C123...` to include a real
`ctx.slack.chat.postMessage(...)` call. Without that variable, the codemode MCP
test does not prove Slack runtime config.
