# iterate

Monorepo for Iterate's Cloudflare Workers platform. **`apps/os`** is the main app — the product dashboard at `os.iterate.com`.

## Irrevocable engineering principle: no deviant system behaviour

We do not accept unexplained, unbounded, or silently tolerated system
behaviour. An error is either an explicitly modelled and correctly classified
expected outcome, or it is a product defect. The same rule applies to retry
storms, stuck work, silent data loss, unexplained latency, state drift, and
resource leaks.

- Never normalize an error counter merely because it is noisy or longstanding.
  Classify every contributing outcome, remove expected outcomes from error
  telemetry, and fix the rest.
- Never swallow, endlessly retry, or hide failures behind fallbacks or
  compatibility shims. Recovery must be bounded, observable, and preserve a
  durable explanation of what happened.
- A healthy request is not enough if it leaves corrupt, stalled, or divergent
  state behind. Verify the resulting state and the relevant production-shaped
  telemetry.
- Green tests are necessary but not sufficient. For operational changes, the
  acceptance proof includes a preview deployment and evidence that its traces,
  logs, metrics, and state transitions are coherent, correctly classified, and
  free of new unexplained errors.

Treat any unexplained error volume as a release blocker until evidence proves
that each outcome is expected and correctly represented outside the error
signal. "Unavoidable error spam" is not a category.

## Environments

- The root `envs.ts` is the typed map of every deployed environment
  (hostnames, worker names, accounts, resource IDs); Doppler supplies only
  secrets, one config per env (`prd`, `preview_N`; `dev`/`dev_<you>` are
  fully local and never deploy).
- Each app deploys with its own small scripts: `pnpm run deploy --env <name>`
  (build → wrangler deploy with atomic secrets → smoke), `ensure-resources`,
  `erase-data`. Workers are never deleted.
- Details: [DevOps: Cloudflare And Doppler](docs/devops-cloudflare-doppler.md).

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

How to open a PR (branch hygiene, body shape, **screenshots that actually
render**, drafts/previews) — and **after open**: wait for Iterate Review /
review bots, address **every** CI/review comment (fix or reply + resolve),
**never leave threads standing**, **never merge on red CI** unless the human
explicitly said so: **[Pull requests](docs/pull-requests.md)**.

**Browser testing:** use an isolated, headed `agent-browser` Chrome for Testing
session by default so the developer can watch it. Give every concurrent agent
a unique session; use headless mode only when explicitly requested or in CI.
This does not mean attach to a developer's actual Chrome. See
[Browser testing](docs/browser-testing.md). Keep the CLI and its corresponding
agent skills up to date.

**Draft PRs don't get a preview deployment** (or preview e2e). If you open a
PR as a draft and want a preview environment, add the `preview` label; marking
the PR ready for review also starts previews. Lease model details:
[Dev environments](docs/dev-environments.md).

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
`<slug>.localhost` hosts), be any user or an admin (minting), point an isolated
visible browser at local dev or a preview, create a preview environment
from your machine, and when you need a public callback URL. Doppler/Cloudflare/deploy details:
`docs/devops-cloudflare-doppler.md`.

## Documentation

### Platform & architecture

- [Architecture](docs/architecture.md)
- [DevOps: Cloudflare And Doppler](docs/devops-cloudflare-doppler.md)
- [Brand & tone](docs/brand-and-tone-of-voice.md)

### Development

- [Pull requests](docs/pull-requests.md) — opening PRs, absolute screenshot URLs, drafts/previews, body hygiene; after open: wait for Iterate Review, address every thread, no merge on red CI
- [Browser testing](docs/browser-testing.md) — isolated agent-browser sessions, visible watch mode, and reusable test logins
- [Dev environments](docs/dev-environments.md) — local dev, minting identities, opening project-scoped or platform-wide operator sessions, browsers for agents, preview-from-local
- [Tunnels](docs/tunnels.md) — public HTTPS URLs for local dev, webhooks, OAuth callbacks, and CI/e2e fixtures
- [Coding style](docs/coding-style.md)
- [Depot CI](docs/depot-ci.md) — workflow editing, Depot CLI commands, monitoring/wait loops, logs, dispatch, metrics, secrets, and gotchas
- [CLI scripts](docs/cli-scripts.md) — how to write normal TypeScript scripts and expose them as CLIs
- [Preview CI performance](docs/ci-preview-performance.md) — how the preview deploy+e2e check stays ~2-3 min, the budget guardrail, and how to keep it fast without raising cost
- [TypeScript conventions](docs/typescript-conventions.md)
- [Frontend development](docs/frontend-development.md) — the apps/os programming model: one capnweb capability tree over one WebSocket, the thin itx hooks (`useSession`/`useItx`, `useItxQuery`/`useSessionQuery`, `useLiveState`), and LiveView-style live state from Durable Objects
- [Design system & React](docs/design-system.md)
- [Slack testing](docs/slack-testing.md) — real Slack flows; **`SLACK_CI_BOT_TOKEN` trigger actor**; channel membership (`#slack-agent-e2e-test`); preview setup; duplicate-bot caveats
- [GitHub production smoke testing](docs/github-smoke-testing.md) — post-recreation config sync, authenticated requests, and webhook routing
- [Slack preview OAuth clients](docs/slack-preview-oauth-clients.md) — bulk-create preview Slack apps and collect Doppler secrets
- [Slack bot token migration](docs/slack-bot-token-migration.md) — per-app bot token fallback links and Doppler shape
- [Testing](docs/testing.md) — test lanes, how to run them against any environment, the canonical env vars, and the retry/timeout policy (one retry layer, fail-fast watchdogs, retry telemetry)
- [Vitest patterns](docs/vitest-patterns.md)
- [Domain objects & stream processors](docs/domain-objects-and-stream-processors.md)
- [Writing & testing stream processors](docs/writing-stream-processors.md) — side-effect guarantees, the obligation/reconciler pattern, eviction recovery, staleness policy, and the node test harness
- [Playwright specs](./spec/AGENTS.md) - instructions for agents writing playwright tests

### Tasks & agent docs

- [Task system](docs/task-system.md)
- [Task grooming](docs/tasks-grooming.md)
- [Writing agent docs](docs/writing-agent-docs.md)
- [Cloudflare trace queries](.agents/skills/cloudflare-traces/SKILL.md) — MCP dataset selection, correlation, and span-tree audits
- [Debugging the OS worker](.agents/skills/debug-os-worker/SKILL.md) — ITX, agents, scheduler alarms, dynamic workers, and error lookup

### App-specific

- [OS app](apps/os/AGENTS.md)
- [Auth app](apps/auth/README.md) — public OIDC/oRPC plus OS-only Workers RPC for the org/project directory
- [itx](apps/os/src/README.md) — the `/api/itx` surface and its public contract (`types.ts`)
- [OS worker topology](apps/os/docs/worker-topology.md)
- [OS architecture & operations](apps/os/docs/architecture-and-operations.md)
- [Debugging deployed OS workers](apps/os/docs/debugging-deployed-os-workers.md)
- [Doppler-backed scripts](apps/os/docs/doppler-backed-scripts.md)
