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

### MacBook (Docker via OrbStack) — `--privileged`

| Workload | Files  | Local disk | Archil          | Slowdown |
| -------- | ------ | ---------- | --------------- | -------- |
| Small    | 2,232  | 1.5s       | 6.0s            | **3x**   |
| Medium   | 32,173 | 20.7s      | 5,382s (90 min) | **260x** |

Requires OrbStack (or a Linux VM with FUSE support) and `--privileged` for `/dev/fuse` access. The MacBook medium result (90 min vs Fly's 25 min) is inflated by home internet latency to Archil's eu-west-1 cluster — the Fly `lhr` numbers are the production-representative ones.

Slowdown scales super-linearly with file count. At 2K files, Archil adds a manageable 5s. At 32K files, it's 56x slower (Fly). Our production monorepo has ~180K files in `node_modules` — extrapolating, that would likely take hours.

## What's slow

The bottleneck is the "added" phase of `pnpm install`. pnpm hardlinks thousands of small files from its content-addressable store into `node_modules`. Each file creation is a FUSE operation that round-trips to Archil's storage cluster. Package downloads are fast — pnpm fetched 829/885 tarballs in seconds — but writing 32K files one-by-one through FUSE took 25 minutes.

Even `find node_modules -type f | wc -l` took ~5 minutes on the Archil mount after install.

### Back-of-envelope vs Archil's claims

Archil [documents](https://docs.archil.com/details/performance) "sub-millisecond" latency for cached read/write operations, with uncached reads at 10-30ms (S3/R2 round-trip). At 0.5ms per FUSE op:

- **Small (2K files):** ~6K ops × 0.5ms = ~3s overhead. We measured ~5s overhead. Roughly matches.
- **Medium (32K files):** ~96K ops × 0.5ms = ~48s overhead. We measured ~1,500s. **31x higher** than the naive estimate.

The gap is explained by what "cached" means here. Archil's sub-millisecond latency applies to operations on data already warm in its SSD cache layer — reads of existing files, writes to known paths. Our benchmark is the worst case: `pnpm install` creating 32K brand-new files in a fresh directory. Every `mkdir`, `link`, and `create` is a new inode Archil has never seen, hitting the uncached write path. At 10-15ms per op (R2 round-trip), 96K ops × ~15ms ≈ 1,440s — close to what we measured.

This penalty applies to any operation that creates new files on the mount — not just a fresh install. Adding a new dependency with many files (e.g. `pnpm install typescript`) would hit the same uncached write path for every new file it links into `node_modules`.

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
