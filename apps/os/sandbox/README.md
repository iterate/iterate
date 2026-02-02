# Sandbox

Minimal, single-image setup. GHCR-backed. Host sync uses rsync into the baked repo path.

## TL;DR

- Image: `ghcr.io/iterate/sandbox`
- Tags: `main`, `sha-<sha>`, `local`
- Repo path in container: `/home/iterate/src/github.com/iterate/iterate`
- pnpm store: `/home/iterate/.pnpm-store` (volume `iterate-pnpm-store`)
- Dev sync mounts (read-only):
  - `/host/repo-checkout` (repo worktree)
  - `/host/gitdir` (worktree git dir)
  - `/host/commondir` (main .git)

## Build

Local build (uses current repo checkout):

```bash
pnpm os snapshot:local-docker
```

Local builds tag both `:local` and `:sha-<sha>` (or `:sha-<sha>-dirty` if dirty). The `:local` tag always points at the most recent local build.

Push to GHCR (updates shared build cache):

```bash
PUSH=1 pnpm os snapshot:local-docker
```

Direct Docker build:

```bash
docker buildx build --load -f apps/os/sandbox/Dockerfile -t ghcr.io/iterate/sandbox:local --build-arg GIT_SHA=$(git rev-parse HEAD) .
```

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
- `LOCAL_DOCKER_IMAGE_NAME` (optional override; script prefers `:local` if present, else `:main`)

These env vars are set by the dev launcher (see `apps/os/alchemy.run.ts`) to keep workerd-safe.

## Daytona snapshots (GHCR pull)

Create snapshot from GHCR image:

```bash
pnpm os snapshot:daytona
```

Defaults:

- Snapshot name: `iterate-sandbox-${GIT_SHA}`
- Image: `ghcr.io/iterate/sandbox:sha-${GIT_SHA}`

Override with env vars:

- `SANDBOX_SNAPSHOT_NAME`
- `SANDBOX_IMAGE`
- `SANDBOX_SNAPSHOT_CPU`, `SANDBOX_SNAPSHOT_MEMORY`, `SANDBOX_SNAPSHOT_DISK`

Requires `daytona` CLI (`daytona login`).

## Push from local

```bash
gh auth login
gh auth token | docker login ghcr.io -u "$(gh api user -q .login)" --password-stdin

docker buildx build --push -f apps/os/sandbox/Dockerfile \\
  -t ghcr.io/iterate/sandbox:main \\
  -t ghcr.io/iterate/sandbox:sha-$(git rev-parse HEAD) \\
  --build-arg GIT_SHA=$(git rev-parse HEAD) \\
  --cache-from type=registry,ref=ghcr.io/iterate/sandbox:buildcache \\
  --cache-to type=registry,ref=ghcr.io/iterate/sandbox:buildcache,mode=max \\
  .
```

## Key files

- `apps/os/sandbox/Dockerfile`
- `apps/os/sandbox/entry.sh`
- `apps/os/sandbox/sync-home-skeleton.sh`
- `apps/os/sandbox/pidnap.config.ts`
