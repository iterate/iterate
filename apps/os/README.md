# OS

OS is the Cloudflare Workers app for Iterate's project workspace UI and
project-scoped runtime APIs.

It combines:

- **The itx engine** (`src/next/`) — the capnweb surface at `/api/itx` plus
  every project-scoped domain: streams, repos, agents, secrets, dynamic
  workers, egress, capabilities. [`src/next/README.md`](./src/next/README.md)
  is the engine guide; [`src/next/types.ts`](./src/next/types.ts) is the
  public contract.
- **The dashboard** — TanStack Start, TanStack Router, and TanStack Query for
  the authenticated UI (`src/routes/`, `src/components/`), talking to the
  engine through the itx React hooks (`src/itx/itx-react.tsx`).
- **The Iterate Auth Worker** for sessions, organizations, and project claims
  — and as the **project directory**: OS has no database of its own; slug →
  project id resolution goes through the auth worker with a `PROJECT_DIRECTORY`
  KV cache in front. All other durable state lives in Durable Object SQLite.
- **Ten deployed workers** — a tiny ingress router, the app, the engine API,
  and one worker per Durable Object class. See
  [docs/worker-topology.md](./docs/worker-topology.md).

Slack and Google integrations are being rebuilt on the engine (in flight);
their pre-migration source is parked in `legacy-quarantine/`.

## How To Use It

Browser users start at the app host and sign in through the Iterate Auth
Worker. There are no organization routes in OS — users without an organization
are redirected to the auth worker's project-access flow. App routes are
project-scoped:

```text
/projects
/projects/:projectSlug
/projects/:projectSlug/agents[/streams/*]
/projects/:projectSlug/reactivity
/projects/:projectSlug/repl
/projects/:projectSlug/repos[/*]
/projects/:projectSlug/secrets
/projects/:projectSlug/streams[/*]
/projects/:projectSlug/settings
/new-project
/admin[/projects, /repl, /streams]
/itx-repl
```

Project slugs are globally unique and exist for readable URLs. Runtime work
uses stable project IDs (`prj_…`). Streams are addressed by
`{ projectId, path }`; `projectId: null` is reserved for deployment-wide
streams. Paths stay project-local, such as `/agents/default`.

Project platform hosts (`<slug>.iterate.app` in prod,
`<slug>.localhost:<port>` in local dev) and `/prj_<id>/...` paths route to the
project's seeded worker, never the dashboard.

## Common Commands

Run from `apps/os`.

```bash
pnpm dev                 # local OS dev with Doppler-backed env (all workers in one workerd)
pnpm typecheck           # TypeScript (includes route-tree freshness check)
pnpm test                # unit tests
pnpm e2e                 # real-worker e2e (engine suites + preview smoke) against a live deployment
pnpm e2e:itx             # the itx example matrix across all execution runtimes
pnpm cli itx run --eval 'return await itx.whoami()'
                         # run an itx script against the deployment in your Doppler config
pnpm cli claude-mcp      # open Claude against the OS MCP server in your local Doppler config
doppler run --project os --config preview_2 -- pnpm run deploy
                         # deploy the explicitly selected Doppler config
doppler run --project os --config prd -- pnpm run deploy
                         # production deploy
```

Use `pnpm run deploy`, not `pnpm deploy`; `deploy` is also a pnpm built-in.

## Running Real-Worker Tests

The e2e lanes run against a real OS deployment, not the Workers Vitest pool:
`pnpm e2e` (config `e2e/vitest.config.ts`: `e2e/vitest/**` plus the engine
suites in `e2e/engine/**`) and `pnpm e2e:itx` (config
`src/itx/e2e/vitest.config.ts`: the example matrix, including a browser
runtime). Start the worker in one terminal, then run tests from another
through the matching Doppler config. For local dev configs, test helpers read
`.alchemy/dev-server.json` to find the selected port; deployed configs get
`APP_CONFIG_BASE_URL` from Doppler.

Local dev normally uses the shared `dev` config. Use a personal `dev_<user>`
config only when you need personal integration secrets.

```bash
# Terminal 1: starts OS locally on http://localhost:<port>.
pnpm dev

# Terminal 2: run real-worker e2e against the discovered local server.
doppler run --project os --config dev -- pnpm e2e
```

Known caveat: a few engine scenarios that load repo-sourced project workers
fail against LOCAL vite dev only (capnweb/vite-dev RpcTarget identity);
verify against a deployed preview before treating one as a regression.

`pnpm dev` is the shorthand for the local Doppler/Alchemy dev flow. It uses
the local Doppler setup for `apps/os` and starts Alchemy with that env. The
dev wrapper writes output to `.alchemy/dev-server.log`, so a second terminal
can follow it with `tail -f .alchemy/dev-server.log`. Lifecycle controls:

```bash
pnpm dev status
pnpm dev start                         # attached, same as plain pnpm dev
pnpm dev start --detach                # background; prints the selected URL
pnpm dev attach                        # follow a pre-existing server log
pnpm dev restart
pnpm dev kill
```

Do not wrap `pnpm dev restart` inside a killable background job — the restart
re-parents the server into that job's process group. Start detached as its own
step instead.

`pnpm cli` uses `scripts/cli.ts`: if already inside `doppler run`, it
preserves that config; otherwise it enters Doppler using the local `apps/os`
setup. Local CLI commands are plain TypeScript modules under
`apps/os/scripts`. Use `doppler run --config <config> -- <command>` when you
want preview/prd app config explicitly.

For example, to open Claude against the production MCP server using the
production `APP_CONFIG_ADMIN_API_SECRET`:

```bash
doppler run --config prd -- pnpm cli claude-mcp
```

The canonical MCP endpoint comes from `APP_CONFIG_MCP__BASE_URL`, for example
`https://mcp.iterate.com` in production. Local dev serves MCP on the normal
app route: `<APP_CONFIG_BASE_URL>/api/mcp`.

Smoke local MCP with the Inspector:

```bash
doppler run --project os --config dev -- sh -lc '
  BASE=$(node -p "require(\"./.alchemy/dev-server.json\").baseUrl")
  npx -y @modelcontextprotocol/inspector --cli "$BASE/api/mcp" \
    --transport http \
    --method tools/list \
    --header "Authorization: Bearer $APP_CONFIG_ADMIN_API_SECRET"
'
```

Then call `exec_js` with a real project slug:

```bash
doppler run --project os --config dev -- sh -lc '
  BASE=$(node -p "require(\"./.alchemy/dev-server.json\").baseUrl")
  npx -y @modelcontextprotocol/inspector --cli "$BASE/api/mcp" \
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

- `src/next/` — **the engine**: `types.ts` (public contract),
  `rpc-targets.ts` (all RpcTargets), `auth.ts`, `domains/*` (DOs + stream
  processors), `workers/*` (engine worker entrypoints). See
  [src/next/README.md](./src/next/README.md).
- `src/workers/` — the non-engine worker entrypoints: `ingress.ts` (the only
  worker with routes) and `app.ts` (the TanStack dashboard).
- `src/itx/` — the client-side itx surface: `itx-react.tsx` (browser hooks),
  `browser-repl.ts` (REPL compiler), `examples.ts` (the example catalogue),
  `e2e/` (the example matrix). The engine itself lives in `src/next/`.
- `src/config.ts` — the `AppConfig` runtime config schema.
- `src/routes/_app` — authenticated app routes; `src/start.ts` installs the
  auth-worker request middleware.
- `alchemy.run.ts` — the deployment: all ten workers, DO namespaces, routes.
- `legacy-quarantine/`, `test-quarantine/` — parked pre-migration source and
  suites, excluded from builds/tests; each has a README cataloguing the way
  back. Do not import from them.

## Read Next

- [Engine README](./src/next/README.md)
- [Worker Topology](./docs/worker-topology.md)
- [Architecture And Operations](./docs/architecture-and-operations.md)
- [Debugging Deployed OS Workers](./docs/debugging-deployed-os-workers.md)
- [Agent Smoke Testing](./docs/agent-smoke-testing.md)
- [Doppler-Backed Scripts](./docs/doppler-backed-scripts.md)
- [Preview Agent Browser Smoke](./docs/preview-agent-browser-smoke.md)
- [Headless Local Debugging](./docs/headless-local-debugging.md)
- [Domain Context](./CONTEXT.md)

## Agent Notes

`AGENTS.md` is a symlink to this file. Keep this README short and move durable
details to `apps/os/docs` or `apps/os/CONTEXT.md`.
