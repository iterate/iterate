# iterate

Monorepo for Iterate's Cloudflare Workers platform. **`apps/os`** is the main app — the product dashboard at `os.iterate.com`.

## Environments = Doppler configs

Everything runs in the context of a **Doppler config** — a named bag of env vars (`APP_CONFIG_BASE_URL`, API secrets, `ALCHEMY_LOCAL`, …). The config determines _which_ OS you're talking to, not a separate code path.

Local dev, preview deploy, and production deploy all use the same primitive from `apps/os`:

```bash
doppler run --project os --config <config> -- tsx ./alchemy.run.ts
```

| Config      | Typical effect                                                 |
| ----------- | -------------------------------------------------------------- |
| `dev_<you>` | Local dev server (`ALCHEMY_LOCAL=true`; what `pnpm dev` wraps) |
| `preview_N` | Deploy to `os.iterate-preview-N.com`                           |
| `prd`       | Deploy to `os.iterate.com`                                     |

Pick the config, run your script — the env vars do the rest. Details: [OS environments](docs/os-environments.md).

## Talking to OS

Run these from `apps/os`. Wrap in `doppler run --project os --config <config> -- …` to target a specific environment; the config supplies URLs and secrets.

### oRPC API

OS exposes oRPC at `/api/orpc/`. The app CLI discovers procedures remotely and authenticates with the config's shared API secret:

```bash
# production (default when no DOPPLER_CONFIG is set)
pnpm cli rpc --help

# preview slot 2
doppler run --project os --config preview_2 -- \
  sh -c 'OS_BASE_URL="$APP_CONFIG_BASE_URL" pnpm cli rpc --help'

# local dev server (while pnpm dev is running)
doppler run --project os --config dev_jonas -- \
  pnpm cli rpc --base-url http://localhost:5183 --help
```

Replace `--help` with a procedure path to call it.

### Claude + project MCP

Open Claude Code against a deployed project's MCP server:

```bash
doppler run --project os --config prd -- \
  pnpm cli claude-mcp --project-slug-or-id my-project
```

The Doppler config picks the environment (prod, preview, your dev tunnel). `APP_CONFIG_PROJECT_HOSTNAME_BASES` in the config sets the project hostname base (e.g. `iterate.app`, `iterate-preview-3.app`); override with `--base-host` if needed.

More: [apps/os README](apps/os/AGENTS.md).

## Quick start

```bash
pnpm install
pnpm dev          # local OS dev server
```

Before PRs:

```bash
pnpm install && pnpm typecheck && pnpm lint && pnpm format && pnpm test
```

## Repository map

**Start here:** `apps/os/`

| Path                | What                                                                               |
| ------------------- | ---------------------------------------------------------------------------------- |
| `apps/os/`          | **Main app** — product dashboard (`os.iterate.com`; dev: `{user}.iterate-dev.com`) |
| `packages/iterate/` | `iterate` CLI — delegates to local source when run inside this repo                |
| `docs/`             | Detailed documentation                                                             |
| `tasks/`            | Work tracking (markdown + frontmatter)                                             |
| `apps/iterate-com/` | iterate.com marketing site                                                         |

Other Cloudflare apps (`events`, `semaphore`, `example`, …) are supporting services — see `docs/architecture.md`.

## Common commands

```bash
pnpm dev                      # local OS dev server
pnpm mcp:dev                  # local MCP app against local auth
pnpm --dir apps/auth dev      # auth app only
pnpm os dev                   # same, explicit apps/os path
pnpm test && pnpm typecheck && pnpm lint && pnpm format
```

Dev server, Doppler, e2e, tunnels: `docs/dev-environment.md`.

## Documentation

### Platform & architecture

- [Architecture](docs/architecture.md)
- [OS environments](docs/os-environments.md)
- [Brand & tone](docs/brand-and-tone-of-voice.md)

### Development

- [Dev environment & Doppler](docs/dev-environment.md)
- [Coding style](docs/coding-style.md)
- [TypeScript conventions](docs/typescript-conventions.md)
- [Design system & React](docs/design-system.md)
- [Vitest patterns](docs/vitest-patterns.md)

### Deploy & Cloudflare

- [Preview environments model](docs/cloudflare-preview-environments.md)
- [Preview & deploy cheat sheet](docs/cloudflare-preview-and-deploy-cheatsheet.md)
- [Drizzle migrations](.agents/skills/drizzle-migrations/SKILL.md) — not for `apps/os` (sqlfu/D1)
- [Fixing Drizzle migration conflicts](docs/fixing-drizzle-migration-conflicts.md)

### Tasks & agent docs

- [Task system](docs/task-system.md)
- [Task grooming](docs/tasks-grooming.md)
- [Writing agent docs](docs/writing-agent-docs.md)

### App-specific

- [OS app](apps/os/AGENTS.md)
- [OS architecture & operations](apps/os/docs/architecture-and-operations.md)
