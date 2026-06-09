# OS

OS is the Cloudflare Workers app for Iterate's project workspace UI and
project-scoped runtime APIs.

It combines:

- TanStack Start, TanStack Router, and TanStack Query for the authenticated UI.
- oRPC over HTTP/OpenAPI at `/api`.
- Iterate Auth Worker for first-party sessions, organizations, project claims,
  and MCP OAuth.
- sqlfu and Cloudflare D1 for app projections.
- Durable Objects for project lifecycle, ingress, MCP sessions, codemode
  sessions, and shared streams.

## How To Use It

Browser users start at the app host and sign in through the Iterate Auth
Worker. Project routes are project-scoped, and organization-level settings live
under `/org/:organizationSlug`:

```text
/projects
/projects/:projectSlug
/projects/:projectSlug/codemode-sessions
/projects/:projectSlug/streams
/projects/:projectSlug/settings
/org/:organizationSlug
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
pnpm cli claude-mcp      # open Claude against the OS MCP server in your local Doppler config
pnpm sqlfu:generate      # regenerate sqlfu migrations/query wrappers
pnpm sqlfu:check         # compare migrations to definitions.sql
pnpm cf:deploy           # production deploy
```

## Running Real-Worker Tests

Some e2e tests, including Cap'n Web and capability-prototype tests, are meant to
run against a real OS Worker, not the Workers Vitest pool. Start the worker in
one terminal, then run tests from another terminal through the matching Doppler
config so `APP_CONFIG_BASE_URL` and admin auth secrets point at that worker.

Tunnel-backed dev uses your normal engineer config. For Jonas:

```bash
# Terminal 1: starts OS locally and creates/uses the dev tunnel.
# If your local Doppler setup for apps/os is dev_jonas, this is enough:
pnpm dev

# Equivalent explicit form:
doppler run --project os --config dev_jonas -- pnpm exec tsx ./alchemy.run.ts

# Terminal 2: run deployed-worker-style e2e against that tunnel.
doppler run --project os --config dev_jonas -- pnpm exec vitest run --config src/capnweb/e2e/vitest.config.ts
```

`pnpm dev` is the shorthand for the local Doppler/Alchemy dev flow. It uses the
local Doppler setup for `apps/os`; inside Doppler, `DOPPLER_CONFIG` is set to
values such as `dev_jonas`.

For tests that do not need the public tunnel, prefer localhost-oriented dev:

```bash
# Terminal 1: local worker without the dev tunnel hostname.
pnpm dev:localhost

# Terminal 2: run real-worker e2e against localhost config.
doppler run --project os --config dev_localhost -- pnpm exec vitest run --config src/domains/capability-prototype/e2e.vitest.config.ts
```

Use `dev_localhost` when validating new local-only routes because it avoids
tunnel setup and still exercises the real worker entrypoint. Use `dev_jonas`
when the flow needs public callback URLs, project hostnames, browser cookies on
the tunnel origin, or other tunnel-backed behavior.

`pnpm cli` uses `scripts/cli.ts`: if already inside `doppler run`, it preserves
that config; otherwise it enters Doppler using the local `apps/os` setup. Use
`doppler run --config <config> -- <command>` when you want preview/prd app
config explicitly.

For example, to open Claude against the production MCP server using the
production `APP_CONFIG_ADMIN_API_SECRET`:

```bash
doppler run --config prd -- pnpm cli claude-mcp
```

The canonical MCP endpoint comes from `APP_CONFIG_MCP__BASE_URL`, for example
`https://mcp.iterate.com` in production or
`https://mcp.iterate-dev-jonas.com` in local tunnel configs. `APP_CONFIG_BASE_URL`
remains the dashboard URL. Localhost-oriented dev defaults MCP to
`<APP_CONFIG_BASE_URL>/api/__mcp`, for example `http://localhost:5176/api/__mcp`.

The script pattern is documented in
[`docs/doppler-backed-scripts.md`](./docs/doppler-backed-scripts.md).

## Important Files

- `src/app.ts` defines the app manifest and runtime config schema.
- `src/entry.workerd.ts` is the Cloudflare Worker entrypoint.
- `src/domains` contains domain-local Durable Objects, WorkerEntrypoints, tool
  providers, and focused README/AGENTS notes.
- `src/start.ts` installs the auth-worker request middleware.
- `src/orpc/root.ts` composes the server router.
- `src/orpc/routers/projects.ts` owns `os.projects` collection APIs and the
  singular `os.project.*` project-scoped router.
- `src/db/definitions.sql` is the sqlfu schema source of truth.
- `src/routes/_app` contains authenticated app routes.
- `alchemy.run.ts` defines Cloudflare deployment resources.

## Read Next

- [Debugging Deployed OS Workers](./docs/debugging-deployed-os-workers.md)
- [Doppler-Backed Scripts](./docs/doppler-backed-scripts.md)
- [Architecture And Operations](./docs/architecture-and-operations.md)
- [Preview Agent Browser Smoke](./docs/preview-agent-browser-smoke.md)
- [Codemode Subrequest Depth](./docs/codemode-subrequest-depth.md)
- [ADR: Replace Clerk With Auth Worker](../../docs/adr/0001-replace-clerk-with-auth-worker.md)
- [Domain Context](./CONTEXT.md)

## Agent Notes

`AGENTS.md` is a symlink to this file. Keep this README short and move durable
details to `apps/os/docs` or `apps/os/CONTEXT.md`.
