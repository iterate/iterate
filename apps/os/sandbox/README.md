# Sandbox

Minimal, single-image setup. Host sync uses rsync into the baked repo path.
Builds use [Depot](https://depot.dev) for persistent layer caching across CI and local dev.

## TL;DR

- Local image: `iterate-sandbox:local`
- Repo path in container: `/home/iterate/src/github.com/iterate/iterate`
- pnpm store: `/home/iterate/.pnpm-store` (volume `iterate-pnpm-store`)
- Dev sync mounts (read-only):
  - `/host/repo-checkout` (repo worktree)
  - `/host/gitdir` (worktree git dir)
  - `/host/commondir` (main .git)

## Build

Local build (uses current repo checkout):

```bash
pnpm os docker:build
```

Tags the image as `iterate-sandbox:local` by default.
Cache is shared automatically via Depot - no manual push needed.

Direct Depot build (bypassing pnpm script):

```bash
depot build --load -f apps/os/sandbox/Dockerfile -t iterate-sandbox:local --build-arg GIT_SHA=$(git rev-parse HEAD) .
```

## Local Depot Setup

Depot provides persistent layer caching shared between CI and all developers.

One-time setup:

```bash
brew install depot/tap/depot   # or: curl -L https://depot.dev/install-cli.sh | sh
depot login
```

After setup, `pnpm os docker:build` uses the shared layer cache automatically.
The project ID in `depot.json` links your local builds to the same cache as CI.

## Dev sync mode

Local sandboxes are created by the local-docker provider (not docker compose).
The container mounts:

- `/host/repo-checkout` (repo worktree, read-only)
- `/host/gitdir` (worktree git dir)
- `/host/commondir` (main .git)

Entry point rsyncs into `/home/iterate/src/github.com/iterate/iterate` and overlays git metadata.
If dependencies change, run `pnpm install` inside the container.

### Env vars (compose)

- `LOCAL_DOCKER_REPO_CHECKOUT` (host repo root)
- `LOCAL_DOCKER_GIT_DIR` (worktree git dir)
- `LOCAL_DOCKER_COMMON_DIR` (main .git)
- `LOCAL_DOCKER_SYNC_FROM_GIT_TARGET` (optional startup git sync target, format `<remote>:<ref>`, e.g. `origin:main`)
- `LOCAL_DOCKER_IMAGE_NAME` (optional override; script prefers `:local` if present, else `:main`)

These env vars are set by the dev launcher (see `apps/os/alchemy.run.ts`) to keep workerd-safe.

## Daytona snapshots

Create snapshot directly from Dockerfile (builds on Daytona's infra):

```bash
pnpm os daytona:build
```

Options:

- `--name` / `-n`: Snapshot name (default: `iterate-sandbox-<sha>` or `iterate-sandbox-<sha>-$ITERATE_USER-dirty`)
- `--cpu` / `-c`: CPU cores (default: 2)
- `--memory` / `-m`: Memory in GB (default: 4)
- `--disk` / `-d`: Disk in GB (default: 10)

Example:

```bash
pnpm os daytona:build --name my-snapshot --cpu 4 --memory 8
```

Requires `daytona` CLI (`daytona login`).

## Key files

- `apps/os/sandbox/Dockerfile`
- `apps/os/sandbox/entry.sh`
- `apps/os/sandbox/sync-home-skeleton.sh`
- `apps/os/sandbox/pidnap.config.ts`
