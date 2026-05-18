# Dev environment

## Local dev server

Run auth + OS together:

```bash
pnpm dev
```

Run a single app:

```bash
pnpm os dev
pnpm --dir apps/auth dev
```

If a dev server is already running and you need its logs, restart it yourself (e.g. with `nohup`, stdout to a log file you can tail). Tell the user when you do this.

## Doppler

Secrets live in [Doppler](https://doppler.com). Most commands resolve the project from `doppler.yaml` based on working directory.

```bash
doppler run -- ./some-script.sh
doppler run -- env | grep POSTHOG_PUBLIC_KEY
```

Assume the user has configured Doppler via the CLI. You usually do not need `--config` unless a doc or script says so.

Repo root and monorepo-wide CI tooling use `_shared`. Each app has its own Doppler project — see `doppler.yaml`.

## E2E tests

App-level e2e tests live next to each app, e.g. `apps/os/e2e/`. Run that app's `test:e2e*` scripts with the required base URL env vars set.

See `docs/vitest-patterns.md`.

## Cloudflare tunnels

Expose local dev servers on public URLs (webhooks, OAuth callbacks):

```bash
DEV_TUNNEL=1 pnpm dev        # → {app}-dev-{ITERATE_USER}.dev.iterate.com
DEV_TUNNEL=bob pnpm dev      # → bob.dev.iterate.com
DEV_TUNNEL=0 pnpm dev        # disabled
```

## Optional: Depot CLI

For faster Docker builds with shared caching:

```bash
brew install depot/tap/depot
depot login
```
