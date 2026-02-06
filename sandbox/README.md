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

## Dependency boundaries

- `sandbox/*` is provider/runtime infra code only.
- `apps/os/backend` (worker/control plane) may import `@iterate-com/sandbox`.
- `apps/daemon` must not depend on sandbox provider abstractions.
- `sandbox/*` must not import `apps/os/*` or any OS worker package.

## Build

Local build (uses current repo checkout):

```bash
pnpm os docker:build
```

Local builds tag both `:local` and `:sha-<sha>` (or `:sha-<sha>-$ITERATE_USER-dirty` if dirty, e.g. `sha-abc123-jonas-dirty`). The `:local` tag always points at the most recent local build.

Push to GHCR (updates shared build cache):

```bash
PUSH=1 pnpm os docker:build
```

Direct Docker build:

```bash
docker buildx build --load -f sandbox/Dockerfile -t iterate-sandbox:local --build-arg GIT_SHA=$(git rev-parse HEAD) .
```

## Dev sync mode

Local sandboxes are created by the docker provider (not docker compose).
The container mounts:

- `/host/repo-checkout` (repo worktree, read-only)
- `/host/gitdir` (worktree git dir)
- `/host/commondir` (main .git)

Entry point rsyncs into `/home/iterate/src/github.com/iterate/iterate` and overlays git metadata.
If dependencies change, run `pnpm install` inside the container.

### Env vars (compose)

- `DOCKER_GIT_REPO_ROOT` (host repo root)
- `DOCKER_GIT_GITDIR` (worktree git dir)
- `DOCKER_GIT_COMMON_DIR` (main .git)
- `DOCKER_IMAGE_NAME` (optional override; script prefers `:local` if present, else `:main`)

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

## Push from local

```bash
gh auth login
gh auth token | docker login ghcr.io -u "$(gh api user -q .login)" --password-stdin

docker buildx build --push -f sandbox/Dockerfile \\
  -t ghcr.io/iterate/sandbox:main \\
  -t ghcr.io/iterate/sandbox:sha-$(git rev-parse HEAD) \\
  --build-arg GIT_SHA=$(git rev-parse HEAD) \\
  --cache-from type=registry,ref=ghcr.io/iterate/sandbox:buildcache \\
  --cache-to type=registry,ref=ghcr.io/iterate/sandbox:buildcache,mode=max \\
  .
```

## Testing

Sandbox integration tests verify both Docker and Daytona providers work correctly.

### Environment Variables

| Variable                   | Description                                 | Default            |
| -------------------------- | ------------------------------------------- | ------------------ |
| `RUN_SANDBOX_TESTS`        | Enable sandbox tests (set to `true`)        | (tests skipped)    |
| `SANDBOX_TEST_PROVIDER`    | Provider to test: `docker` or `daytona`     | `docker`           |
| `SANDBOX_TEST_SNAPSHOT_ID` | Image (Docker) or snapshot name (Daytona)   | See defaults below |
| `KEEP_SANDBOX_CONTAINER`   | Keep containers after tests (for debugging) | `false`            |

Default snapshot IDs:

- Docker: `iterate-sandbox:local` (fallbacks to `ghcr.io/iterate/sandbox:local`, then `ghcr.io/iterate/sandbox:main`)
- Daytona: reads from `DAYTONA_SNAPSHOT_NAME` in Doppler

### Run Locally

```bash
# Docker provider (requires local image build first)
pnpm sandbox docker:build
pnpm sandbox test:docker

# Daytona provider (requires Doppler secrets)
doppler run -- pnpm sandbox test:daytona

# With specific snapshot
RUN_SANDBOX_TESTS=true SANDBOX_TEST_PROVIDER=docker \
  SANDBOX_TEST_SNAPSHOT_ID=ghcr.io/iterate/sandbox:sha-abc123 \
  pnpm sandbox test

# Keep containers for debugging
KEEP_SANDBOX_CONTAINER=true pnpm sandbox test:docker
```

### CI Workflows

| Workflow                | Description                                    |
| ----------------------- | ---------------------------------------------- |
| `sandbox-test.yml`      | Runs both Docker and Daytona tests in parallel |
| `local-docker-test.yml` | Docker provider only                           |
| `daytona-test.yml`      | Daytona provider only                          |

Workflows trigger on PRs/pushes to `sandbox/**`, `apps/daemon/**`.

### Test Files

- `sandbox/test/helpers.ts` - Test fixtures and provider factory
- `sandbox/test/sandbox-without-daemon.test.ts` - Fast tests (no pidnap)
- `sandbox/test/daemon-in-sandbox.test.ts` - Full integration tests

## Key files

- `sandbox/Dockerfile`
- `sandbox/entry.sh`
- `sandbox/sync-home-skeleton.sh`
- `sandbox/pidnap.config.ts`
