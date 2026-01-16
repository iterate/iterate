# Sandbox

The sandbox container runs agents in isolated Docker environments.

## How It Works

The Docker **build context** determines what version of iterate is bundled in the image. The entire repo (including `.git`) is COPYed into the container at build time.

### Deployment Scenarios

- **Production (Daytona)**: CI builds from `main` branch → image pushed to registry → Daytona uses that image. Agent versions (OpenCode, Claude Code, Bun, etc.) are locked in the Dockerfile.

- **Staging/Feature Branch (CI)**: CI builds from that branch → special image created → pushed to Daytona. Allows testing branch-specific changes.

- **Local Docker Development**: Build from your local working directory. On container restart, `entry.sh` rsyncs your local files into the container, runs `pnpm install`, rebuilds the daemon, and re-copies `home-skeleton/`. Edit code locally, restart container to pick up changes.

## Key Files

| File             | Purpose                                                                              |
| ---------------- | ------------------------------------------------------------------------------------ |
| `Dockerfile`     | Image definition; COPY repo from build context                                       |
| `entry.sh`       | Container entrypoint; rsync in local mode, then start s6                             |
| `setup-home.sh`  | Copies `home-skeleton/` to `$HOME`; used at build time AND in local mode after rsync |
| `home-skeleton/` | Agent configs (Claude Code, OpenCode, Pi) baked into `$HOME`                         |
| `s6-daemons/`    | Service definitions for s6 process supervisor                                        |

## Version Configuration

Agent versions are `ENV` vars at the top of the Dockerfile (prefix `SANDBOX_`):

| ENV var                           | Description                 |
| --------------------------------- | --------------------------- |
| `SANDBOX_OPENCODE_VERSION`        | npm version for OpenCode    |
| `SANDBOX_CLAUDE_CODE_VERSION`     | npm version for Claude Code |
| `SANDBOX_PI_CODING_AGENT_VERSION` | npm version for Pi          |
| `SANDBOX_BUN_VERSION`             | Bun version                 |

To update: edit `ENV` values in `Dockerfile`, rebuild image.

## Building

```bash
# Local development (uses your working directory)
pnpm run snapshot:local-docker

# Or directly:
docker build -t iterate-sandbox:local -f apps/os/sandbox/Dockerfile .
```

## Entry Script Flow

`entry.sh` runs on container start:

```
Local mode (mount at /local-iterate-repo exists):
  1. rsync local repo → ~/src/github.com/iterate/iterate
  2. pnpm install
  3. vite build daemon
  4. setup-home.sh (copy home-skeleton to $HOME)
  5. Start s6-svscan

Daytona/CI mode (no mount):
  1. Start s6-svscan (code + configs already baked in)
```

---

# s6 Supervision

Services in `s6-daemons/` are supervised by [s6](https://skarnet.org/software/s6/).

## Services

| Service        | Port | Logs                      | Description          |
| -------------- | ---- | ------------------------- | -------------------- |
| iterate-daemon | 3000 | `/var/log/iterate-daemon` | Main daemon + web UI |
| opencode       | 4096 | `/var/log/opencode`       | OpenCode server      |

## Commands

```bash
export S6DIR=~/src/github.com/iterate/iterate/apps/os/sandbox/s6-daemons

s6-svstat $S6DIR/iterate-daemon   # status
s6-svc -t $S6DIR/iterate-daemon   # restart (SIGTERM)
s6-svc -d $S6DIR/iterate-daemon   # stop
s6-svc -u $S6DIR/iterate-daemon   # start
```

## Logs

```bash
tail -f /var/log/iterate-daemon/current
```
