# OS

OS is the Cloudflare Workers app for Iterate's project workspace UI and
project-scoped runtime APIs.

It combines:

- **itx** (`src/`) — the capnweb surface at `/api` plus
  every project-scoped domain: streams, repos, agents, secrets, dynamic
  workers, egress, capabilities. [`src/README.md`](./src/README.md)
  is itx guide; [`src/itx-api.generated.ts`](./src/itx-api.generated.ts) is
  the public contract (generated from the RpcTarget classes + zod schemas).
- **The dashboard** — TanStack Start, TanStack Router, and TanStack Query for
  the authenticated UI (`src/routes/`, `src/components/`), talking to the
  itx through the React hooks (`iterate/sdk/itx/react` — see `docs/frontend-development.md`).
- **The Iterate Auth Worker** for sessions, organizations, and project claims
  — and as the **project directory**: OS has no database of its own; slug →
  project id resolution goes through the auth worker with a `PROJECT_DIRECTORY`
  KV cache in front. All other durable state lives in Durable Object SQLite.
- **One product worker** (plus two compiler sidecars) — dashboard, itx
  API, and every Durable Object class in a single script. Dynamic workers
  build through a stateless `@cloudflare/worker-bundler` Worker service; no
  build container is involved. See
  [docs/worker-topology.md](./docs/worker-topology.md).

Integrations are connections at fully qualified paths
(`/integrations/<slug>/<connection>`): built-ins (Slack, Google) are named
members of `itx.integrations`, and projects mount their own through the
capability table. See [docs/integrations.md](./docs/integrations.md).

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
pnpm e2e                 # real-worker e2e against a live deployment (engine suites + itx example matrix)
pnpm cli itx run --eval 'return await itx.whoami()'
                         # run an itx script against the deployment in your Doppler config
pnpm cli claude-mcp      # open Claude against the OS MCP server in your local Doppler config
doppler run --project os --config preview_2 -- pnpm run deploy
                         # deploy the explicitly selected Doppler config
doppler run --project os --config prd -- pnpm run deploy
                         # production deploy
doppler run --config prd -- pnpm cli session create --project <slug-or-id> --open
                         # open one production project with a confined operator principal
```

Use `pnpm run deploy`, not `pnpm deploy`; `deploy` is also a pnpm built-in.

## Running Real-Worker Tests

The e2e suite runs against a real OS deployment, not the Workers Vitest pool:
`pnpm e2e` (config `e2e/vitest.config.ts`, one project named `node` covering
the engine suites in `e2e/vitest/**` and the itx example matrix in
`e2e/examples/**`; browser catalogue coverage is the root Playwright spec
`specs/repl-examples.spec.ts`). Start the worker in one terminal, then run
tests from another
through the matching Doppler config. For local dev configs, test helpers read
`.dev-server/dev-server.json` to find the selected port; deployed configs get
`APP_CONFIG_BASE_URL` from Doppler. All lanes, targets, and the canonical env
vars: [docs/testing.md](../../docs/testing.md).

Local dev normally uses the shared `dev` config. Use a personal `dev_<user>`
config only when you need personal integration secrets.

```bash
# Terminal 1: starts OS locally on http://localhost:<port>.
pnpm dev

# Terminal 2: run real-worker e2e against the discovered local server.
doppler run --project os --config dev -- pnpm e2e
```

Known caveat: a few itx e2e scenarios that load repo-sourced project workers
fail against LOCAL vite dev only (capnweb/vite-dev RpcTarget identity);
verify against a deployed preview before treating one as a regression.

`pnpm dev` runs `doppler run -- vite dev` in this worktree (config from the
local Doppler setup for `apps/os`). When detached, the dev wrapper writes
output to `.dev-server/dev-server.log`, so a second terminal
can follow it with `tail -f .dev-server/dev-server.log`. Lifecycle controls:

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
  BASE=$(node -p "require(\"./.dev-server/dev-server.json\").baseUrl")
  npx -y @modelcontextprotocol/inspector --cli "$BASE/api/mcp" \
    --transport http \
    --method tools/list \
    --header "Authorization: Bearer $APP_CONFIG_ADMIN_API_SECRET"
'
```

Then call `exec_typescript` with a real project slug:

```bash
doppler run --project os --config dev -- sh -lc '
  BASE=$(node -p "require(\"./.dev-server/dev-server.json\").baseUrl")
  npx -y @modelcontextprotocol/inspector --cli "$BASE/api/mcp" \
    --transport http \
    --method tools/call \
    --tool-name exec_typescript \
    --tool-arg project=<project-slug> \
    --tool-arg "code=async (itx) => { return await itx.__describe(); }" \
    --header "Authorization: Bearer $APP_CONFIG_ADMIN_API_SECRET"
'
```

The script pattern is documented in
[`docs/doppler-backed-scripts.md`](./docs/doppler-backed-scripts.md).
Semantic restoration after deliberate production erases is documented in
[`docs/project-seeds.md`](./docs/project-seeds.md).
Project-scoped and platform-wide operator browser sessions are documented in
[`docs/operator-sessions.md`](./docs/operator-sessions.md).

## Important Files

- `src/` — **itx**: `types.ts` (public contract),
  `rpc-targets.ts` (all RpcTargets), `auth.ts`, `domains/*` (DOs + stream
  processors), `worker.ts` (the worker entry). See
  [src/README.md](./src/README.md).
- `src/itx/` — the client-side itx surface (browser hooks now live in the\n `iterate` package — `iterate/client` + `iterate/sdk/itx/react`):
  `browser-repl.ts` (REPL compiler), `examples.ts` (the example catalogue),
  `e2e/` (the example matrix). itx itself lives in `src/`.
- `src/config.ts` — the `AppConfig` runtime config schema.
- `src/routes/_app` — authenticated app routes; `src/start.ts` installs the
  auth-worker request middleware.
- `wrangler.jsonc` — the deployment config, generated from root `envs.ts` plus
  the environment's Alchemy resource manifest by
  `scripts/generate-wrangler-config.ts` (one worker, all DO classes; see
  docs/worker-topology.md). Deploys: `pnpm run deploy --env <name>`.

## History

The itx engine and every project-scoped domain were rebuilt in the itx-v4
migration (PR #1585, landed 2026-07); the detailed migration and test-harness
reports are recoverable from git history at that PR. The durable record of
test coverage removed without replacement is
[docs/removed-test-coverage-itx-v4.md](./docs/removed-test-coverage-itx-v4.md).

## Read Next

- [itx README](./src/README.md)
- [Agent context and turns](./docs/agents.md) — the context event, projection, keyed publication boundary, request rendering, and compaction
- [Integrations](./docs/integrations.md)
- [GitHub pull-request agents](./docs/github-agents.md)
- [Worker Topology](./docs/worker-topology.md)
- [Dynamic Worker Dispatch](./docs/dynamic-worker-dispatch.md) — the capability tree vs the fetch lane; why WebSockets demand the class's own `fetch` handler
- [Sandboxes](./docs/sandboxes.md) — how OUR sandbox works: identity, persistence, egress, the repo checkout (incl. local dev with OrbStack)
- [Cloudflare Sandboxes & Containers](./docs/cloudflare-sandboxes.md) — platform guide: namespace layout, **SSH into an instance**, feature inventory, deprecations, ops
- [Architecture And Operations](./docs/architecture-and-operations.md)
- [Debugging Deployed OS Workers](./docs/debugging-deployed-os-workers.md)
- [Smoke-Testing A Deployment](../../docs/smoke-testing.md) — deploy-inline probes + manual recipes
- [Agent Smoke Testing](./docs/agent-smoke-testing.md)
- [Doppler-Backed Scripts](./docs/doppler-backed-scripts.md)
- [Project Seeds](./docs/project-seeds.md) — capture and restore selected projects across a deliberate data erase without replaying old streams
- [Preview Agent Browser Smoke](./docs/preview-agent-browser-smoke.md)
- [Headless Local Debugging](./docs/headless-local-debugging.md)
- [Domain Context](./CONTEXT.md)

## Agent Notes

`AGENTS.md` is a symlink to this file. Keep this README short and move durable
details to `apps/os/docs` or `apps/os/CONTEXT.md`.
