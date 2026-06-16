# OS

OS is the Cloudflare Workers app for Iterate's project workspace UI and
project-scoped runtime APIs.

It combines:

- TanStack Start, TanStack Router, and TanStack Query for the authenticated UI.
- itx capability handles over `/api/itx` for browser, CLI, MCP, and script
  execution.
- Iterate Auth Worker for first-party sessions, organizations, project claims,
  and MCP OAuth.
- sqlfu and Cloudflare D1 for app projections.
- Durable Objects for project lifecycle, ingress, MCP sessions, agents, repos,
  workspaces, itx contexts, and shared streams.

## How To Use It

Browser users start at the app host and sign in through the Iterate Auth
Worker. There are no organization routes in OS — users without an organization
are redirected to the auth worker's project-access flow. App routes are
project-scoped:

```text
/projects
/projects/:projectSlug
/projects/:projectSlug/agents
/projects/:projectSlug/integrations
/projects/:projectSlug/mcp
/projects/:projectSlug/repl
/projects/:projectSlug/repos
/projects/:projectSlug/streams
/projects/:projectSlug/settings
/new-project
```

Project slugs are globally unique and exist for readable URLs. Runtime work uses
stable project IDs. OS binds shared stream capabilities to a stream
`namespace`; today that namespace is the project ID, so stream paths stay
project-local, such as `/agents/default` or `/integrations/slack`.

## Common Commands

Run from `apps/os`.

```bash
pnpm dev                 # local Cloudflare/TanStack dev through Doppler
pnpm typecheck           # TypeScript
pnpm test                # unit tests
pnpm e2e -t "OS preview smoke"
                         # deployed preview smoke
pnpm cli claude-mcp      # open Claude against the OS MCP server in your local Doppler config
pnpm sqlfu:generate      # regenerate sqlfu migrations/query wrappers
pnpm sqlfu:check         # compare migrations to definitions.sql
doppler run --project os --config preview_9 -- pnpm deploy
                         # deploy the explicitly selected Doppler config
doppler run --project os --config prd -- pnpm deploy
                         # production deploy
```

## Running Real-Worker Tests

Some e2e tests are meant to run against a real OS Worker, not the Workers
Vitest pool. There are two lanes: `pnpm e2e` (config `e2e/vitest.config.ts`)
and the itx suite `pnpm e2e:itx` (config `src/itx/e2e/vitest.config.ts`).
Start the worker in one terminal, then run tests from another terminal through
the matching Doppler config. For local dev configs, test helpers read
`.alchemy/dev-server.json` to find the selected port; deployed configs still
get `APP_CONFIG_BASE_URL` from Doppler.

Local dev works with the shared `dev` config or a personal `dev_<user>` config.
For Jonas:

```bash
# Terminal 1: starts OS locally on http://localhost:<port>.
# If your local Doppler setup for apps/os is dev_jonas, this is enough:
pnpm dev

# Equivalent explicit form:
doppler run --project os --config dev_jonas -- pnpm cli dev start

# Terminal 2: run real-worker e2e against the discovered local server.
doppler run --project os --config dev_jonas -- pnpm e2e
```

`pnpm dev` is the shorthand for the local Doppler/Alchemy dev flow. It uses the
local Doppler setup for `apps/os`; inside Doppler, `DOPPLER_CONFIG` is set to
values such as `dev_jonas`. The dev wrapper writes output to
`.alchemy/dev-server.log`, so a second terminal can follow it with
`tail -f .alchemy/dev-server.log`.

The same local server lifecycle is also available through the app CLI:

```bash
pnpm cli dev status
pnpm cli dev start                     # attached, same as pnpm dev
pnpm cli dev start --detach            # background; prints the selected URL
pnpm cli dev attach                    # follow a pre-existing server log
pnpm cli dev restart
pnpm cli dev restart --detach
pnpm cli dev kill
```

The shared `dev` config behaves the same way:

```bash
# Terminal 1: local worker on http://localhost:<port>.
doppler run --project os --config dev -- pnpm dev

# Terminal 2: run real-worker e2e against the discovered local server.
doppler run --project os --config dev -- pnpm e2e:itx
```

Personal `dev_<user>` configs should not carry app/MCP/project-host URL
overrides. They run the same localhost dev server as `dev`. Use preview or
production when a flow needs a public callback URL.

`pnpm cli` uses `scripts/cli.ts`: if already inside `doppler run`, it preserves
that config; otherwise it enters Doppler using the local `apps/os` setup. Local
CLI commands are loaded from `packages/iterate/src/os/router.ts`. Use
`doppler run --config <config> -- <command>` when you want preview/prd app
config explicitly.

For example, to open Claude against the production MCP server using the
production `APP_CONFIG_ADMIN_API_SECRET`:

```bash
doppler run --config prd -- pnpm cli claude-mcp
```

The canonical MCP endpoint comes from `APP_CONFIG_MCP__BASE_URL`, for example
`https://mcp.iterate.com` in production. Local dev deliberately keeps MCP
path-mounted on the curlable app origin: `<APP_CONFIG_BASE_URL>/api/__mcp`, for
example `http://localhost:5176/api/__mcp`.

Smoke local MCP with the Inspector:

```bash
doppler run --project os --config dev -- sh -lc '
  BASE=$(node -p "require(\"./.alchemy/dev-server.json\").baseUrl")
  npx -y @modelcontextprotocol/inspector --cli "$BASE/api/__mcp" \
    --transport http \
    --method tools/list \
    --header "Authorization: Bearer $APP_CONFIG_ADMIN_API_SECRET"
'
```

Then call `exec_js` with a real project slug:

```bash
doppler run --project os --config dev -- sh -lc '
  BASE=$(node -p "require(\"./.alchemy/dev-server.json\").baseUrl")
  npx -y @modelcontextprotocol/inspector --cli "$BASE/api/__mcp" \
    --transport http \
    --method tools/call \
    --tool-name exec_js \
    --tool-arg project=<project-slug> \
    --tool-arg "code=async (itx) => { return await itx.describe(); }" \
    --header "Authorization: Bearer $APP_CONFIG_ADMIN_API_SECRET"
'
```

The script pattern is documented in
[`docs/doppler-backed-scripts.md`](./docs/doppler-backed-scripts.md).

## Important Files

- `src/workers/` holds the per-worker entrypoints — OS deploys as many small
  workers (tiny ingress router, the TanStack app, one worker per Durable
  Object class). See [docs/worker-topology.md](./docs/worker-topology.md).
- `src/config.ts` holds the `AppConfig` runtime config schema.
- `src/itx` contains the itx handle system, browser hooks, script runner, and
  capability dispatch.
- `src/domains` contains domain-local Durable Objects, WorkerEntrypoints,
  capabilities, and focused README/AGENTS notes.
- `src/start.ts` installs the auth-worker request middleware.
- `src/db/definitions.sql` is the sqlfu schema source of truth.
- `src/routes/_app` contains authenticated app routes.
- `alchemy.run.ts` defines Cloudflare deployment resources.

## Read Next

- [Debugging Deployed OS Workers](./docs/debugging-deployed-os-workers.md)
- [Agent Smoke Testing](./docs/agent-smoke-testing.md)
- [Doppler-Backed Scripts](./docs/doppler-backed-scripts.md)
- [Architecture And Operations](./docs/architecture-and-operations.md)
- [Preview Agent Browser Smoke](./docs/preview-agent-browser-smoke.md)
- [Headless Local Debugging](./docs/headless-local-debugging.md)
- [ADR: Replace Clerk With Auth Worker](../../docs/adr/0001-replace-clerk-with-auth-worker.md)
- [Domain Context](./CONTEXT.md)

## Agent Notes

`AGENTS.md` is a symlink to this file. Keep this README short and move durable
details to `apps/os/docs` or `apps/os/CONTEXT.md`.
