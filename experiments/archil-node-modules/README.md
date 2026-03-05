# Archil node_modules benchmark

Can Archil back `node_modules` for AI coding agent sandboxes? Each sandbox is a Fly.io machine that runs `pnpm install` on startup. If `node_modules` persisted on Archil across machine restarts, cold starts would be instant.

## Setup

Three dimensions, fully crossed (up to 8 scenarios):

| Dimension    | Values                                                            |
| ------------ | ----------------------------------------------------------------- |
| **Disk**     | Local disk (baseline) vs Archil FUSE mount                        |
| **Workload** | Small (5 npm libs, 2K files) vs Medium (12 TS devDeps, 32K files) |
| **Machine**  | Fly.io `lhr` (London) vs MacBook (Docker)                         |

Archil disk is in `aws-eu-west-1` (Ireland), backed by Cloudflare R2 (Western Europe). When using Archil, both `node_modules` and the pnpm content-addressable store are on the Archil mount (bind-mounted into the project). This is required because pnpm hardlinks files from the store into `node_modules` — both must be on the same filesystem.

## Results

### Fly.io `lhr` — 4 shared vCPUs, 4 GB RAM

| Workload | Files  | Local disk | Archil          | Slowdown |
| -------- | ------ | ---------- | --------------- | -------- |
| Small    | 2,232  | 1.6s       | 6.5s            | **4x**   |
| Medium   | 32,173 | 27s        | 1,530s (25 min) | **56x**  |

### MacBook (Docker) — baseline only

| Workload | Files  | Local disk |
| -------- | ------ | ---------- |
| Small    | 2,232  | 1.5s       |
| Medium   | 32,173 | 20.7s      |

Archil scenarios can't run in Docker Desktop (no `/dev/fuse` in the VM). These baselines confirm the Fly local-disk numbers are comparable.

Slowdown scales super-linearly with file count. At 2K files, Archil adds a manageable 5s. At 32K files, it's 56x slower. Our production monorepo has ~180K files in `node_modules` — extrapolating, that would likely take hours.

## What's slow

The bottleneck is the "added" phase of `pnpm install`. pnpm hardlinks thousands of small files from its content-addressable store into `node_modules`. Each file creation is a FUSE operation that round-trips to Archil's storage cluster. Package downloads are fast — pnpm fetched 829/885 tarballs in seconds — but writing 32K files one-by-one through FUSE took 25 minutes.

Even `find node_modules -type f | wc -l` took ~5 minutes on the Archil mount after install.

## Reproducing

```bash
# 1. Provision Archil disk (one-time, needs ARCHIL_API_KEY_EU_WEST in Doppler)
doppler run -- npx tsx setup-disks.ts

# 2. Run individual scenarios
doppler run -- ./run.sh fly    local-disk  small-workload
doppler run -- ./run.sh fly    archil-disk medium-workload
doppler run -- ./run.sh docker local-disk  small-workload
# ... etc

# 3. Generate results.md from raw logs
./generate-results.sh
```

Each `run.sh` invocation saves a log file to `raw-logs/`. Results are never overwritten — re-run a scenario to replace its log, then re-generate.

## Files

| File                  | Purpose                                           |
| --------------------- | ------------------------------------------------- |
| `benchmark.sh`        | Container entrypoint — accepts MODE and WORKLOAD  |
| `run.sh`              | Runs one scenario, saves raw log to `raw-logs/`   |
| `generate-results.sh` | Reads `raw-logs/`, produces `results.md`          |
| `setup-disks.ts`      | Provisions Archil disk via SDK                    |
| `Dockerfile`          | Benchmark container (node 22 + pnpm + archil CLI) |
| `raw-logs/`           | One `.log` file per scenario                      |
| `results.md`          | Generated — two tables + raw logs                 |
