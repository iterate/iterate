# Sandbox

Minimal, single-image setup. Depot/Fly-registry-backed. Host sync uses rsync into the baked repo path.

## TL;DR

- Image: `iterate-sandbox` (local) and `registry.fly.io/iterate-sandbox-image` (remote)
- Tags: `main`, `sha-<sha>`, `local`
- Repo path in container: `/home/iterate/src/github.com/iterate/iterate`
- pnpm store: `/home/iterate/.pnpm-store` (volume `iterate-pnpm-store`)
- Dev sync mounts (read-only):
  - `/host/repo-checkout` (repo worktree)
  - `/host/gitdir` (worktree git dir)
  - `/host/commondir` (main .git)

## Dependency boundaries

- `apps/os/backend` (OS worker/control plane) may import `@iterate-com/sandbox`.
- `apps/daemon` must not import `@iterate-com/sandbox`.
- `sandbox/*` must not import `apps/os/*` or `apps/daemon/*`.
- Flow is one-way: `apps/os/backend -> @iterate-com/sandbox -> provider SDKs`.

## Build

Local build (uses current repo checkout):

```bash
pnpm docker:build
```

Local builds tag both `:local` and `:sha-<sha>` (or `:sha-<sha>-$ITERATE_USER-dirty` if dirty, e.g. `sha-abc123-jonas-dirty`). The `:local` tag always points at the most recent local build.

Push to Fly registry via Depot build:

```bash
SANDBOX_USE_DEPOT_REGISTRY=true \
SANDBOX_DEPOT_SAVE_TAG=iterate-sandbox-local-$(date +%s) \
SANDBOX_PUSH_FLY_REGISTRY=true \
pnpm docker:build
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
- `DOCKER_SERVICE_TRANSPORT` (`port-map` or `cloudflare-tunnel`; default `port-map`)
- `DOCKER_CLOUDFLARE_TUNNEL_PORTS` (optional CSV, default `3000,3001,4096,9876`)
- `CLOUDFLARE_TUNNEL_HOSTNAME` (optional; if set, pidnap runs a `cloudflared` tunnel process)
- `CLOUDFLARE_TUNNEL_URL` (optional; defaults to `http://127.0.0.1:3000`)

These env vars are set by the dev launcher (see `apps/os/alchemy.run.ts`) to keep workerd-safe.

## Daytona snapshots

Create snapshot directly from Dockerfile (builds on Daytona's infra):

```bash
pnpm build:daytona
```

Options:

- `--name` / `-n`: Snapshot name (default: `iterate-sandbox-<sha>` or `iterate-sandbox-<sha>-$ITERATE_USER-dirty`)
- `--cpu` / `-c`: CPU cores (default: 2)
- `--memory` / `-m`: Memory in GB (default: 4)
- `--disk` / `-d`: Disk in GB (default: 10)

Example:

```bash
pnpm build:daytona --name my-snapshot --cpu 4 --memory 8
```

Requires `daytona` CLI (`daytona login`).

## Push from local

```bash
FLY_TOKEN="${FLY_API_TOKEN:-${FLY_API_KEY:-}}"
flyctl apps create iterate-sandbox-image -o "$FLY_ORG" -y
flyctl auth docker -t "$FLY_TOKEN"

depot build --platform linux/amd64 --progress=plain --push \
  -t registry.fly.io/iterate-sandbox-image:main \
  -t registry.fly.io/iterate-sandbox-image:sha-$(git rev-parse HEAD) \
  -f sandbox/Dockerfile .
```

## Testing

Sandbox integration tests verify Docker, Fly, and Daytona providers.

### Environment Variables

| Variable                   | Description                                   | Default            |
| -------------------------- | --------------------------------------------- | ------------------ |
| `RUN_SANDBOX_TESTS`        | Enable sandbox tests (set to `true`)          | (tests skipped)    |
| `SANDBOX_TEST_PROVIDER`    | Provider to test: `docker`, `fly`, `daytona`  | `docker`           |
| `SANDBOX_TEST_SNAPSHOT_ID` | Image/snapshot override for selected provider | See defaults below |
| `KEEP_SANDBOX_CONTAINER`   | Keep containers after tests (for debugging)   | `false`            |

Default snapshot IDs:

- Docker: `iterate-sandbox:local` (fallbacks to `iterate-sandbox:main`, then `registry.fly.io/iterate-sandbox-image:main`)
- Fly: `registry.fly.io/iterate-sandbox-image:main`
- Daytona: reads from `DAYTONA_SNAPSHOT_NAME` in Doppler

### Run Locally

```bash
# Docker provider (requires local image build first)
pnpm sandbox docker:build
pnpm sandbox test:docker

# Docker provider, Cloudflare tunnel transport
RUN_SANDBOX_TESTS=true SANDBOX_TEST_PROVIDER=docker \
  RUN_DOCKER_CLOUDFLARE_TUNNEL_TESTS=true \
  pnpm sandbox test --run providers/docker/cloudflare-tunnel.test.ts
# Optional: REQUIRE_CLOUDFLARE_TUNNEL_TEST_SUCCESS=true to fail instead of
# soft-skipping when Cloudflare quick tunnels are rate-limited (HTTP 429/1015).

# Daytona provider (requires Doppler secrets)
doppler run -- pnpm sandbox test:daytona

# Fly provider (requires Doppler secrets)
doppler run -- sh -c 'RUN_SANDBOX_TESTS=true SANDBOX_TEST_PROVIDER=fly pnpm sandbox test test/provider-base-image.test.ts --maxWorkers=1'

# With specific snapshot
RUN_SANDBOX_TESTS=true SANDBOX_TEST_PROVIDER=docker \
  SANDBOX_TEST_SNAPSHOT_ID=iterate-sandbox:sha-abc123 \
  pnpm sandbox test

# Keep containers for debugging
KEEP_SANDBOX_CONTAINER=true pnpm sandbox test:docker
```

### CI Workflows

| Workflow           | Description                                              |
| ------------------ | -------------------------------------------------------- |
| `sandbox-test.yml` | Runs Docker, Fly, and Daytona provider test jobs         |
| `daytona-test.yml` | Daytona-only provider smoke test (manual/targeted usage) |

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
