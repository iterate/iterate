# Sandbox

The sandbox container runs agents in isolated Docker environments.

## How It Works

The Docker build context determines what version of iterate is bundled in the image. The entire repo (including `.git`) is COPYed into the container at build time.

### Deployment Scenarios

- Production (Daytona): CI builds from `main` branch → image pushed to registry → Daytona uses that image.
- Staging/Feature Branch (CI): CI builds from that branch → special image created → pushed to Daytona.
- Local Docker Dev: build from your working directory. On container start, the daemon bootstrap syncs `/local-iterate-repo`, installs deps, rebuilds daemon, and restarts PM2.

## Key Files

| File                       | Purpose                                                           |
| -------------------------- | ----------------------------------------------------------------- |
| `Dockerfile`               | Image definition; COPY repo from build context                    |
| `ecosystem.config.cjs`     | PM2 service definitions (daemon + opencode)                       |
| `setup-home.sh`            | Copies `home-skeleton/` to `$HOME` (build time + local bootstrap) |
| `home-skeleton/`           | Agent configs (Claude Code, OpenCode, Pi) baked into `$HOME`      |
| `local-docker-snapshot.ts` | Script to build local Docker image                                |
| `local-docker.test.ts`     | Integration test for local Docker sandbox                         |

## Version Configuration

Agent versions are `ENV` vars at the top of the Dockerfile (prefix `SANDBOX_`). Update values, rebuild image.

## Building & Testing

### Local Docker

```bash
pnpm snapshot:local-docker
pnpm snapshot:local-docker:test
```

### Daytona

```bash
SANDBOX_ITERATE_REPO_REF=$(git branch --show-current) pnpm snapshot:daytona:prd
SANDBOX_ITERATE_REPO_REF=my-feature-branch pnpm snapshot:daytona:prd
pnpm snapshot:daytona:test
SANDBOX_ITERATE_REPO_REF=my-feature-branch pnpm snapshot:daytona:test
DAYTONA_SNAPSHOT_NAME=prd--20260116-230007 pnpm snapshot:daytona:test
```

### Direct Docker Build

```bash
docker build -t iterate-sandbox:local -f apps/os/sandbox/Dockerfile .
```

## Bootstrap Flow

The daemon starts with `--auto-run-bootstrap` and handles:

1. If `/local-iterate-repo` exists: rsync → `pnpm install` → daemon build → `setup-home.sh`
2. Fetch env vars from control plane (if connected)
3. Write `~/.iterate/.env`
4. Restart PM2 so services re-read env

## PM2 Supervision

Services are managed by PM2 via `ecosystem.config.cjs`.

### Commands

```bash
pm2 list
pm2 restart /home/iterate/src/github.com/iterate/iterate/apps/os/sandbox/ecosystem.config.cjs
pm2 logs
```

Logs live in `~/.pm2/logs/`.
