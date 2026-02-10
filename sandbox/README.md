# Sandbox

Minimal, single-image setup. Depot builds with Fly and Depot registry pushes. Host sync uses rsync into the baked repo path.

## Image tagging

One universal tag format across all providers:

```
sha-{7charShortSha}[-dirty]
```

- `sha-abc1234` = clean build of that commit
- `sha-abc1234-dirty` = built with uncommitted changes on top of that commit
- CI builds are always clean (no `-dirty`). Local builds append `-dirty` when `git status --porcelain` is non-empty.

| Provider       | Full identifier                                             |
| -------------- | ----------------------------------------------------------- |
| Docker local   | `iterate-sandbox:sha-abc1234`                               |
| Fly registry   | `registry.fly.io/iterate-sandbox:sha-abc1234`               |
| Depot registry | `registry.depot.dev/{depotProjectId}:sha-abc1234`           |
| Daytona        | `iterate-sandbox-sha-abc1234` (no colons in snapshot names) |

No mutable tags (`:local`, `:latest`, `:main`). Every tag is immutable and commit-based.

## Registries

| Registry                              | Purpose                                          |
| ------------------------------------- | ------------------------------------------------ |
| Local Docker daemon                   | Development — run sandboxes locally              |
| Fly registry (`registry.fly.io`)      | Fly provider pulls images from here at runtime   |
| Depot registry (`registry.depot.dev`) | CI artifact storage, fast pulls on Depot runners |
| Daytona snapshots                     | Daytona provider creates sandboxes from these    |

Both Fly and Depot registries are pushed to automatically when their respective tokens are available (`FLY_API_TOKEN` for Fly, Depot OIDC for Depot).

## Fly naming model

Two separate concepts:

1. Machine app names (runtime):
   - Controlled by `FLY_APP_NAME_PREFIX` (per Doppler config)
   - Expected values:
     - `dev`: `dev`
     - `stg`: `stg`
     - `prd`: `prd`
   - Current behavior: each environment uses exactly one Fly app (all machines in that stage share the same app).
   - This is temporary and may be changed later.
2. Image registry app (build/push):
   - Controlled by `SANDBOX_FLY_REGISTRY_APP`
   - Shared across all environments
   - Expected value: `iterate-sandbox`
   - Image tags look like `registry.fly.io/iterate-sandbox:sha-abc1234`

Why split:

- runtime isolation by environment (`dev`, `stg`, `prd`)
- one shared image artifact source (`iterate-sandbox`)
- simpler CI image build/push flow

If `SANDBOX_FLY_REGISTRY_APP` points to a missing Fly app, image push fails with:
`POST https://registry.fly.io/v2/<app>/blobs/uploads/: 404 Not Found`.

## How defaults work

```
Doppler env var (per config: dev/stg/prd)
  │
  ▼
Provider.defaultSnapshotId
  │
  ▼  (can be overridden by)
Machine metadata (per-machine override in create-machine UI)
  │
  ▼
Actual image used for sandbox creation
```

| Provider | Default env var            | Format                                        |
| -------- | -------------------------- | --------------------------------------------- |
| Docker   | `DOCKER_DEFAULT_IMAGE`     | `iterate-sandbox:sha-abc1234`                 |
| Fly      | `FLY_DEFAULT_IMAGE`        | `registry.fly.io/iterate-sandbox:sha-abc1234` |
| Daytona  | `DAYTONA_DEFAULT_SNAPSHOT` | `iterate-sandbox-sha-abc1234`                 |

The create-machine UI fetches current defaults via `machine.getDefaultSnapshots` tRPC endpoint and pre-fills them. Leave blank to use the Doppler default, or enter a fully-qualified tag to override.

## Build

### Quick reference

```bash
# Build image (pushes to Fly + Depot registries when tokens available, loads locally)
pnpm sandbox build

# Build without loading into local Docker (faster, registry-only)
SANDBOX_SKIP_LOAD=true pnpm sandbox build

# Push local image to Daytona as snapshot (updates your Doppler config)
pnpm sandbox daytona:push

# Push with custom name
pnpm sandbox daytona:push --name my-custom-snapshot
```

### Build script: `pnpm sandbox build`

Runs `sandbox/providers/docker/build-image.ts` via Depot for persistent layer caching.

| Env var                     | Description                               | Default                         |
| --------------------------- | ----------------------------------------- | ------------------------------- |
| `SANDBOX_BUILD_PLATFORM`    | Target platform(s)                        | `linux/amd64,linux/arm64`       |
| `SANDBOX_SKIP_LOAD`         | Skip `--load` into local Docker           | `false`                         |
| `SANDBOX_FLY_REGISTRY_APP`  | Fly registry app used for image pushes    | required (`iterate-sandbox`)    |
| `SANDBOX_PUSH_FLY_REGISTRY` | Push to Fly registry                      | auto (based on `FLY_API_TOKEN`) |
| `SANDBOX_UPDATE_DOPPLER`    | Update Doppler after Fly push             | `true`                          |
| `SANDBOX_DOPPLER_CONFIGS`   | Comma-separated Doppler configs to update | current config                  |

`SANDBOX_FLY_REGISTRY_APP` is required. There is no code fallback.

The build always saves to Depot registry (`--save`). Fly registry push happens automatically when `FLY_API_TOKEN` is available.

Local builds auto-update your current Doppler config with `DOCKER_DEFAULT_IMAGE`, and with `FLY_DEFAULT_IMAGE` when Fly push is enabled. You can override either in Doppler manually.

### Daytona snapshot: `pnpm sandbox daytona:push`

Pushes the local Docker image to Daytona as a named snapshot.

```bash
pnpm sandbox daytona:push [--name NAME] [--image IMAGE] [--cpu N] [--memory N] [--disk N] [--no-update-doppler]
```

Snapshot name format: `iterate-sandbox-sha-{shortSha}[-dirty]`.

### Direct Docker build (no Depot)

```bash
docker buildx build --load -f sandbox/Dockerfile -t iterate-sandbox:local --build-arg GIT_SHA=$(git rev-parse HEAD) .
```

## CI pipeline

### On PR

```
1. build-sandbox-image (push to Fly + Depot registries)
2a. Docker sandbox tests    (needs: build-sandbox-image)
2b. Push Daytona snapshot   (needs: build-sandbox-image)
3.  Daytona e2e tests       (needs: push-daytona-snapshot)
```

### On main merge

```
1. build-sandbox-image (push to Fly + Depot registries)
2. push-daytona-snapshot (needs: build-sandbox-image)
3. Update Doppler defaults (FLY_DEFAULT_IMAGE + DAYTONA_DEFAULT_SNAPSHOT for dev/stg/prd)
4. Deploy OS worker (needs: push-daytona-snapshot)
```

### CI workflows

| Workflow              | File                        | Purpose                                          |
| --------------------- | --------------------------- | ------------------------------------------------ |
| Build Sandbox Image   | `build-sandbox-image.yml`   | Builds image, pushes to Fly + Depot registries   |
| Push Daytona Snapshot | `push-daytona-snapshot.yml` | Pushes local image to Daytona                    |
| CI                    | `ci.yml`                    | Orchestrates build → push → deploy on main merge |
| Sandbox Tests         | `sandbox-test.yml`          | Build + test across all providers                |

All CI workflows are defined as TypeScript in `.github/ts-workflows/workflows/` and generated to YAML with `pnpm workflows`.

## Dependency boundaries

- `apps/os/backend` (OS worker/control plane) may import `@iterate-com/sandbox`.
- `apps/daemon` must not import `@iterate-com/sandbox`.
- `sandbox/*` must not import `apps/os/*` or `apps/daemon/*`.
- Flow is one-way: `apps/os/backend -> @iterate-com/sandbox -> provider SDKs`.

## Dev sync mode

Local sandboxes (Docker provider) mount host directories read-only:

- `/host/repo-checkout` (repo worktree)
- `/host/gitdir` (worktree git dir)
- `/host/commondir` (main .git)

Entry point rsyncs into `/home/iterate/src/github.com/iterate/iterate` and overlays git metadata.

### Env vars (Docker provider)

| Env var                            | Description                                   |
| ---------------------------------- | --------------------------------------------- |
| `DOCKER_HOST_GIT_REPO_ROOT`        | Host repo root                                |
| `DOCKER_HOST_GIT_DIR`              | Worktree git dir                              |
| `DOCKER_HOST_GIT_COMMON_DIR`       | Main .git dir                                 |
| `DOCKER_DEFAULT_IMAGE`             | Image to use                                  |
| `DOCKER_DEFAULT_SERVICE_TRANSPORT` | `port-map` or `cloudflare-tunnel`             |
| `DOCKER_TUNNEL_PORTS`              | CSV of ports (default: `3000,3001,4096,9876`) |

Set by the dev launcher (`apps/os/alchemy.run.ts`).

## Fly app bootstrap and cleanup

```bash
# Create/ensure Fly apps and sync Doppler
# - shared image app: iterate-sandbox
# - machine app prefixes: dev, stg, prd
pnpm sandbox fly:bootstrap-apps

# Cleanup stale machines
pnpm sandbox fly:cleanup -- 24h stop dev    # stop machines idle >24h
pnpm sandbox fly:cleanup -- 7d delete stg   # delete machines idle >7d
```

## Testing

| Variable                   | Description                       | Default          |
| -------------------------- | --------------------------------- | ---------------- |
| `RUN_SANDBOX_TESTS`        | Enable sandbox tests (`true`)     | (tests skipped)  |
| `SANDBOX_TEST_PROVIDER`    | `docker`, `fly`, or `daytona`     | `docker`         |
| `SANDBOX_TEST_SNAPSHOT_ID` | Image/snapshot override for tests | provider default |
| `KEEP_SANDBOX_CONTAINER`   | Keep containers after tests       | `false`          |

```bash
# Docker
pnpm sandbox build && pnpm sandbox test:docker

# Daytona
doppler run -- pnpm sandbox test:daytona

# Fly
doppler run -- sh -c 'RUN_SANDBOX_TESTS=true SANDBOX_TEST_PROVIDER=fly pnpm sandbox test test/provider-base-image.test.ts --maxWorkers=1'
```

## Key files

- `sandbox/Dockerfile` — image definition
- `sandbox/entry.sh` — container entrypoint
- `sandbox/sync-home-skeleton.sh` — dev sync setup
- `sandbox/pidnap.config.ts` — process manager config
- `sandbox/providers/docker/build-image.ts` — build script (Depot + Fly/Depot registry push)
- `sandbox/providers/daytona/push-snapshot.ts` — Daytona snapshot push script
- `sandbox/providers/docker/provider.ts` — Docker provider
- `sandbox/providers/fly/provider.ts` — Fly provider
- `sandbox/providers/daytona/provider.ts` — Daytona provider
- `sandbox/providers/machine-stub.ts` — machine stub abstraction used by control plane
