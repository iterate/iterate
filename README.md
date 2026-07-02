# iterate

Monorepo for Iterate's Cloudflare Workers platform. **`apps/os`** is the main app — the product dashboard at `os.iterate.com`.

## Environments

- Commands run in the context of a Doppler config; that config chooses secrets,
  app config, Cloudflare account, and Alchemy stage.
- Local dev, previews, and production use the same `alchemy.run.ts` primitive
  with different configs: shared `dev`, personal `dev_<you>`, `preview_N`, or
  `prd`.
- Details: [DevOps: Cloudflare, Doppler, And Alchemy](docs/devops-cloudflare-doppler-alchemy-setup.md).

## Talking to OS

Run these from `apps/os`. Plain `pnpm cli ...` uses your local Doppler setup
for `apps/os`. Wrap in `doppler run --config <config> -- ...` to target a
specific environment; the config supplies URLs and secrets. More on this script
pattern: [Doppler-backed scripts](apps/os/docs/doppler-backed-scripts.md).

### itx API

OS exposes project capability handles through `/api/itx`. The app CLI
authenticates with the config's admin API secret and can run scripts against a
project's itx surface:

```bash
# your local Doppler setup, normally shared dev
pnpm cli itx --help

# production
doppler run --config prd -- pnpm cli itx --help

# preview slot 3
doppler run --config preview_3 -- pnpm cli itx --help

# local dev server (while pnpm dev is running)
doppler run --config dev -- pnpm cli itx --help
```

Use `pnpm cli itx run --help` to run a script against a project.

### Claude + project MCP

Open Claude Code against the OS MCP server for a deployment:

```bash
doppler run --config prd -- pnpm cli claude-mcp
```

The Doppler config picks the environment (prod, preview, or local dev). `APP_CONFIG_PROJECT_HOSTNAME_BASES` in the config sets the deployed project hostname base (e.g. `iterate.app`, `iterate-preview-3.app`); local dev project hosts use `<slug>.localhost:<port>`. Override with `--base-host` if needed.

More: [apps/os README](apps/os/AGENTS.md).

## Quick start

```bash
pnpm install
doppler setup --config dev --no-interactive   # once per worktree; doppler.yaml scopes every app dir
pnpm dev                                      # attached local OS dev server (http://localhost:<port>)
```

Use `pnpm dev <action> [flags]` for dev server lifecycle controls (`status`,
`start --detach`, `attach`, `restart`, `kill`). The shared `dev` config and
personal `dev_<you>` configs are fully local and safe for parallel worktrees;
use captun, preview, or production for public callbacks. Details:
[Dev environments](docs/dev-environments.md).

Before PRs:

```bash
pnpm install && pnpm typecheck && pnpm lint && pnpm format && pnpm test
```

## Repository map

**Start here:** `apps/os/`

| Path                | What                                                                               |
| ------------------- | ---------------------------------------------------------------------------------- |
| `apps/os/`          | **Main app** — product dashboard (`os.iterate.com`; local dev: `localhost:<port>`) |
| `packages/iterate/` | `iterate` CLI — delegates to local source when run inside this repo                |
| `docs/`             | Detailed documentation                                                             |
| `tasks/`            | Work tracking (markdown + frontmatter)                                             |
| `apps/iterate-com/` | iterate.com marketing site                                                         |

Other Cloudflare apps (`semaphore`, …) are supporting services — see `docs/architecture.md`.

## Common commands

```bash
doppler setup --config dev --no-interactive   # once per worktree (or --config dev_<you> for personal secrets)
pnpm dev                      # attached local OS dev server at http://localhost:<port> (see docs/dev-environments.md)
pnpm auth:mint                # mint a session as any user/admin (repo root; dev/preview; wrap in doppler run)
pnpm --dir apps/auth dev      # auth app only (when working on auth itself)
pnpm test && pnpm typecheck && pnpm lint && pnpm format
```

How do I…? — **[Dev environments](docs/dev-environments.md)** answers: run
local dev (fully local, random port, `localhost` plus project
`<slug>.localhost` hosts), be any user or an admin (minting), point a browser
(headless golden path) at local dev or a preview, create a preview environment
from your machine, and when you need a public callback URL. Doppler/Cloudflare/deploy details:
`docs/devops-cloudflare-doppler-alchemy-setup.md`.

## Documentation

### Platform & architecture

- [Architecture](docs/architecture.md)
- [DevOps: Cloudflare, Doppler, And Alchemy](docs/devops-cloudflare-doppler-alchemy-setup.md)
- [Brand & tone](docs/brand-and-tone-of-voice.md)

### Development

- [Dev environments](docs/dev-environments.md) — local dev, minting identities/admin sessions, browsers for agents, preview-from-local
- [Coding style](docs/coding-style.md)
- [CI workflows](docs/ci-workflows.md) — generated GitHub Actions, Depot runners, and the one Depot CI image-bake workflow
- [TypeScript conventions](docs/typescript-conventions.md)
- [Design system & React](docs/design-system.md)
- [Testing](docs/testing.md) — test lanes, how to run them against any environment, and the canonical env vars
- [Vitest patterns](docs/vitest-patterns.md)
- [Domain objects & stream processors](docs/domain-objects-and-stream-processors.md)

### Tasks & agent docs

- [Task system](docs/task-system.md)
- [Task grooming](docs/tasks-grooming.md)
- [Writing agent docs](docs/writing-agent-docs.md)

### App-specific

- [OS app](apps/os/AGENTS.md)
- [The itx engine](apps/os/src/next/README.md) — the `/api/itx` engine and its public contract (`types.ts`)
- [OS worker topology](apps/os/docs/worker-topology.md)
- [OS architecture & operations](apps/os/docs/architecture-and-operations.md)
- [Debugging deployed OS workers](apps/os/docs/debugging-deployed-os-workers.md)
- [Doppler-backed scripts](apps/os/docs/doppler-backed-scripts.md)
