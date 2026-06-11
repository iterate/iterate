# iterate

Monorepo for Iterate's Cloudflare Workers platform. **`apps/os`** is the main app — the product dashboard at `os.iterate.com`.

## Environments

- Commands run in the context of a Doppler config; that config chooses secrets,
  app config, Cloudflare account, and Alchemy stage.
- Local dev, previews, and production use the same `alchemy.run.ts` primitive
  with different configs: `dev_<you>`, `preview_N`, or `prd`.
- Details: [DevOps: Cloudflare, Doppler, And Alchemy](docs/devops-cloudflare-doppler-alchemy-setup.md).

## Talking to OS

Run these from `apps/os`. Plain `pnpm cli ...` uses your local Doppler setup
for `apps/os`. Wrap in `doppler run --config <config> -- ...` to target a
specific environment; the config supplies URLs and secrets. More on this script
pattern: [Doppler-backed scripts](apps/os/docs/doppler-backed-scripts.md).

### oRPC API

OS exposes oRPC at `/api/orpc/`. The app CLI discovers procedures remotely and authenticates with the config's admin API secret:

```bash
# your local Doppler setup, normally dev_<you>
pnpm cli rpc --help

# production
doppler run --config prd -- pnpm cli rpc --help

# preview slot 3
doppler run --config preview_3 -- pnpm cli rpc --help

# local dev server (while pnpm dev is running)
doppler run --config dev_jonas -- pnpm cli --base-url http://localhost:5173 rpc --help

# localhost-oriented config (while pnpm dev:localhost is running)
doppler run --config dev_localhost -- pnpm cli rpc --help
```

Replace `--help` with a procedure path to call it.

### Claude + project MCP

Open Claude Code against a deployed project's MCP server:

```bash
doppler run --config prd -- pnpm cli claude-mcp --project-slug-or-id my-project
```

The Doppler config picks the environment (prod, preview, your dev tunnel). `APP_CONFIG_PROJECT_HOSTNAME_BASES` in the config sets the project hostname base (e.g. `iterate.app`, `iterate-preview-3.app`); override with `--base-host` if needed.

More: [apps/os README](apps/os/AGENTS.md).

## Quick start

```bash
pnpm install
pnpm dev          # fully-local OS dev server (http://os.localhost:<port>)
```

Before PRs:

```bash
pnpm install && pnpm typecheck && pnpm lint && pnpm format && pnpm test
```

## Repository map

**Start here:** `apps/os/`

| Path                | What                                                                                  |
| ------------------- | ------------------------------------------------------------------------------------- |
| `apps/os/`          | **Main app** — product dashboard (`os.iterate.com`; dev: `os.iterate-dev-<user>.com`) |
| `packages/iterate/` | `iterate` CLI — delegates to local source when run inside this repo                   |
| `docs/`             | Detailed documentation                                                                |
| `tasks/`            | Work tracking (markdown + frontmatter)                                                |
| `apps/iterate-com/` | iterate.com marketing site                                                            |

Other Cloudflare apps (`semaphore`, …) are supporting services — see `docs/architecture.md`.

## Common commands

```bash
pnpm dev                      # fully-local OS dev server at http://os.localhost:<port> (see docs/dev-environments.md)
pnpm auth:mint                # mint a session as any user/admin (dev/preview; wrap in doppler run)
pnpm --dir apps/auth dev      # auth app only (when working on auth itself)
pnpm test && pnpm typecheck && pnpm lint && pnpm format
```

How do I…? — **[Dev environments](docs/dev-environments.md)** answers: run
local dev (fully local, random port, `os.localhost`), be any user or an admin
(minting), point a browser (headless golden path) at local dev or a preview,
create a preview environment from your machine, and when you actually need a
tunnel. Doppler/Cloudflare/deploy details:
`docs/devops-cloudflare-doppler-alchemy-setup.md`.

## Documentation

### Platform & architecture

- [Architecture](docs/architecture.md)
- [DevOps: Cloudflare, Doppler, And Alchemy](docs/devops-cloudflare-doppler-alchemy-setup.md)
- [Brand & tone](docs/brand-and-tone-of-voice.md)

### Development

- [Dev environments](docs/dev-environments.md) — local dev, minting identities/admin sessions, browsers for agents, preview-from-local
- [Coding style](docs/coding-style.md)
- [TypeScript conventions](docs/typescript-conventions.md)
- [Design system & React](docs/design-system.md)
- [Vitest patterns](docs/vitest-patterns.md)
- [Domain objects & stream processors](docs/domain-objects-and-stream-processors.md)

### Tasks & agent docs

- [Task system](docs/task-system.md)
- [Task grooming](docs/tasks-grooming.md)
- [Writing agent docs](docs/writing-agent-docs.md)

### App-specific

- [OS app](apps/os/AGENTS.md)
- [OS architecture & operations](apps/os/docs/architecture-and-operations.md)
- [Debugging deployed OS workers](apps/os/docs/debugging-deployed-os-workers.md)
- [Doppler-backed scripts](apps/os/docs/doppler-backed-scripts.md)
