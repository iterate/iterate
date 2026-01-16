# Sandbox

The sandbox container runs agents in isolated Docker environments. Two modes:

- **Local Docker**: Development on your machine with live code sync
- **Daytona**: Production/staging with pre-baked code

## Version Configuration

Versions are declared as `ENV` vars at the top of the Dockerfile (all prefixed with `SANDBOX_`):

| ENV var                           | Default   | Description                                     |
| --------------------------------- | --------- | ----------------------------------------------- |
| `SANDBOX_OPENCODE_GIT_REF`        | `v1.1.17` | Git tag/ref for OpenCode (built from source)    |
| `SANDBOX_CLAUDE_CODE_VERSION`     | `2.1.6`   | npm version for Claude Code                     |
| `SANDBOX_PI_CODING_AGENT_VERSION` | `0.44.0`  | npm version for PI                              |
| `SANDBOX_BUN_VERSION`             | `1.3.5`   | Bun version (must match opencode's requirement) |

Only `SANDBOX_ITERATE_GIT_REF` is a build ARG that can be overridden at build time:

| ARG                       | Default | Description                                        |
| ------------------------- | ------- | -------------------------------------------------- |
| `SANDBOX_ITERATE_GIT_REF` | `main`  | Branch/commit for iterate repo (CI overrides this) |

### Updating Versions

**To update agent versions:**

1. Edit the `ENV` values directly in `Dockerfile`
2. Rebuild the image

**Note:** When changing `SANDBOX_OPENCODE_GIT_REF`, you may also need to update `SANDBOX_BUN_VERSION` to match the version in opencode's `package.json` `packageManager` field.

### Building

```bash
# Use defaults
docker build -t iterate-sandbox:local -f apps/os/sandbox/Dockerfile .

# Override SANDBOX_ITERATE_GIT_REF for a feature branch (CI does this)
docker build \
  --build-arg SANDBOX_ITERATE_GIT_REF=feature-branch \
  -t iterate-sandbox:local \
  -f apps/os/sandbox/Dockerfile .
```

### Layer Caching

Docker's layer caching ensures fast rebuilds:

1. **Static layers** (apt-get, bun, npm globals) - always cached
2. **Claude/PI layers** - rebuild when their `ENV` versions change
3. **OpenCode layers** - rebuild when `SANDBOX_OPENCODE_GIT_REF` changes (includes bun install + build)
4. **Iterate layers** - rebuild when `SANDBOX_ITERATE_GIT_REF` ARG changes

`pnpm dev` runs `docker build` in background - Docker decides if rebuild needed.

## Local vs Daytona Mode

**Local Docker** (`pnpm dev`):

1. Image built with defaults (or your custom refs)
2. Container mounts local repo at `/local-iterate-repo`
3. `entry.sh` detects mount, rsyncs source into container
4. Restart container to pick up local code changes

**Daytona** (CI/production):

1. Image built with specific refs via `--build-arg`
2. No mount - uses baked-in code
3. `entry.sh` skips rsync, uses pre-installed deps

## Entry Script Flow

`entry.sh` runs on container start:

```
Local mode (mount exists):
  1. rsync from /local-iterate-repo → ~/src/github.com/iterate/iterate
  2. pnpm install
  3. vite build daemon
  4. Copy home-skeleton configs to $HOME
  5. Start s6-svscan

Daytona mode (no mount):
  1. Skip sync (use baked-in code and configs)
  2. Start s6-svscan
```

## Agent Config Files (home-skeleton)

Agent configs (Claude Code, OpenCode, Pi) live in `apps/os/sandbox/home-skeleton/` and are **copied** to `$HOME` at:

- **Image build time** — baked into the image
- **Container restart (local mode only)** — re-copied from synced repo

**Daytona containers**: Configs are frozen at image build time. To update configs in a running Daytona container, manually copy from the repo:

```bash
cp -r ~/src/github.com/iterate/iterate/apps/os/sandbox/home-skeleton/. ~/
```

---

# Sandbox Supervision (s6)

The sandbox container uses [s6](https://skarnet.org/software/s6/) to supervise services in `apps/os/sandbox/s6-daemons/`. `s6-svscan` starts everything on boot.

## Service Layout

```
apps/os/sandbox/s6-daemons/iterate-daemon/
├── run
├── finish
├── timeout-kill
├── metadata.json
└── log/
    └── run
```

## Current Services

| Service        | Port | Logs                      | Description          |
| -------------- | ---- | ------------------------- | -------------------- |
| iterate-daemon | 3000 | `/var/log/iterate-daemon` | Main daemon + web UI |
| opencode       | -    | `/var/log/opencode`       | OpenCode agent       |

## Managing Services

All commands assume you're inside the container. Set up the path shortcut first:

```bash
export S6DIR=/home/iterate/src/github.com/iterate/iterate/apps/os/sandbox/s6-daemons
```

### Check Service Status

```bash
# Single service status
s6-svstat $S6DIR/iterate-daemon
# Output: up (pid 563) 471 seconds

# All services status
for svc in $S6DIR/*/; do echo "=== $(basename $svc) ==="; s6-svstat "$svc"; done
```

### Restart a Service

```bash
# Send SIGTERM and restart (graceful restart)
s6-svc -t $S6DIR/iterate-daemon

# Hard restart: stop then start
s6-svc -d $S6DIR/iterate-daemon  # stop (down)
s6-svc -u $S6DIR/iterate-daemon  # start (up)
```

### Other Service Controls

```bash
# Stop a service (stays down until manually started)
s6-svc -d $S6DIR/iterate-daemon

# Start a stopped service
s6-svc -u $S6DIR/iterate-daemon

# Send SIGKILL (force kill)
s6-svc -k $S6DIR/iterate-daemon
```

### Quick Reference

| Command           | Action                           |
| ----------------- | -------------------------------- |
| `s6-svstat <svc>` | Show status (pid, uptime)        |
| `s6-svc -t <svc>` | Restart (SIGTERM + auto-restart) |
| `s6-svc -d <svc>` | Stop (down)                      |
| `s6-svc -u <svc>` | Start (up)                       |
| `s6-svc -k <svc>` | Force kill (SIGKILL)             |

## Logs

```bash
docker logs <container-id>
docker exec <container-id> tail -f /var/log/iterate-daemon/current
```

## Health Checks

```bash
curl http://localhost:3000/api/health
```

## Run Script Pattern

Run scripts get `$ITERATE_REPO` and read config from `metadata.json`:

```bash
#!/bin/sh
exec 2>&1
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PORT=$(node -p "require('$SCRIPT_DIR/metadata.json').port")

cd "$ITERATE_REPO/apps/daemon"
exec env HOSTNAME=0.0.0.0 PORT="$PORT" tsx server.ts
```
