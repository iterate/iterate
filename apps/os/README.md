# OS

OS is the Cloudflare Workers app for Iterate's project workspace UI and
project-scoped runtime APIs.

It combines:

- TanStack Start, TanStack Router, and TanStack Query for the authenticated UI.
- oRPC over HTTP/OpenAPI at `/api`.
- Clerk for first-party sessions, organizations, and MCP OAuth.
- sqlfu and Cloudflare D1 for app projections.
- Durable Objects for project lifecycle, ingress, MCP sessions, codemode
  sessions, and shared streams.

## How To Use It

Browser users start at the app host and sign in with Clerk. Authenticated app
routes are organization-scoped:

```text
/orgs/:organizationSlug/projects
/orgs/:organizationSlug/projects/:projectSlug
/orgs/:organizationSlug/projects/:projectSlug/codemode-sessions
/orgs/:organizationSlug/projects/:projectSlug/streams
/orgs/:organizationSlug/projects/:projectSlug/settings
```

Project slugs are globally unique and exist for readable URLs. Runtime work uses
stable project IDs. OS binds shared stream capabilities to a stream
`namespace`; today that namespace is the project ID, so stream paths stay
project-local, such as `/codemode-sessions/<id>`.

## Common Commands

Run from `apps/os`.

```bash
pnpm dev                 # local Cloudflare/TanStack dev through Doppler
pnpm dev:localhost       # localhost-oriented config
pnpm typecheck           # TypeScript
pnpm test                # unit tests
pnpm e2e -t "OS preview smoke"
                         # deployed preview smoke
pnpm cli claude-mcp --project-slug-or-id bob
                         # open Claude against one project MCP server
pnpm sqlfu:generate      # regenerate sqlfu migrations/query wrappers
pnpm sqlfu:check         # compare migrations to definitions.sql
pnpm cf:deploy           # production deploy
```

Use `doppler run --project os --config <config> -- <command>` when a command
needs deployed secrets or preview/prd app config.

For example, to open Claude against the production MCP server for project
`bob`, using the production `APP_CONFIG_ADMIN_API_SECRET`:

```bash
doppler run --project os --config prd -- \
  pnpm cli claude-mcp --project-slug-or-id bob
```

## Important Files

- `src/app.ts` defines the app manifest and runtime config schema.
- `src/entry.workerd.ts` is the Cloudflare Worker entrypoint.
- `src/domains` contains domain-local Durable Objects, WorkerEntrypoints, tool
  providers, and focused README/AGENTS notes.
- `src/start.ts` installs Clerk's TanStack Start middleware.
- `src/orpc/root.ts` composes the server router.
- `src/orpc/routers/projects.ts` owns `os.projects` collection APIs and the
  singular `os.project.*` project-scoped router.
- `src/db/definitions.sql` is the sqlfu schema source of truth.
- `src/routes/_app` contains authenticated app routes.
- `alchemy.run.ts` defines Cloudflare deployment resources.

## Read Next

- [Architecture And Operations](./docs/architecture-and-operations.md)
- [Preview Agent Browser Smoke](./docs/preview-agent-browser-smoke.md)
- [Codemode Subrequest Depth](./docs/codemode-subrequest-depth.md)
- [ADR: Use Clerk As MCP OAuth Server](./docs/adr/0001-use-clerk-as-mcp-oauth-server.md)
- [Domain Context](./CONTEXT.md)

## Agent Notes

`AGENTS.md` is a symlink to this file. Keep this README short and move durable
details to `apps/os/docs` or `apps/os/CONTEXT.md`.
