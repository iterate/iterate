# Archil node_modules benchmark

We're evaluating whether Archil can back `node_modules` for our AI coding agent sandboxes. Each sandbox is a Fly.io machine that runs `pnpm install` on startup. We want `node_modules` to persist across machine restarts via Archil, so cold starts are fast.

## Setup

- **Compute:** Fly.io machine in `lhr` (London), 4 shared vCPUs, 4 GB RAM
- **Archil disk:** `aws-eu-west-1` (Ireland), backed by Cloudflare R2 in Western Europe
- **Workload:** `pnpm install lodash chalk request commander express`
  - 114 packages, 2232 files in `node_modules`
- **Archil config:** Both `node_modules` and the pnpm content-addressable store are on the Archil mount (bind-mounted into the project directory). This is required because pnpm hardlinks files from the store into `node_modules` — both must be on the same filesystem.

## Results

| Scenario   | pnpm install | Files | Slowdown |
| ---------- | ------------ | ----- | -------- |
| Local disk | 1.6s         | 2232  | 1x       |
| Archil     | 6.5s         | 2232  | **4x**   |

Raw output in [results.md](./results.md).

## Observations

With a small dependency set (114 packages, 2232 files), Archil is ~4x slower than local disk. This is a cold install — no cached data on the Archil disk.

For context, our production monorepo has ~2300 packages and ~180,000 files in `node_modules`. In an earlier test with a repo of that scale (815 packages, 30,906 files), the Archil install timed out at 5 minutes with only 165/815 packages written — the slowdown scaled super-linearly, closer to 100x.

The bottleneck is the "added" phase of `pnpm install`. pnpm hardlinks thousands of small files from its content-addressable store into `node_modules`. Each file creation is a FUSE operation that round-trips to Archil's storage cluster.

## Reproducing

```bash
# 1. Provision Archil disks (needs ARCHIL_API_KEY_EU_WEST in Doppler)
doppler run -- npx tsx setup-disks.ts

# 2. Run on Fly
doppler run -- ./run-on-fly.sh
```

## Files

| File             | Purpose                                                                   |
| ---------------- | ------------------------------------------------------------------------- |
| `benchmark.sh`   | Container entrypoint — runs baseline or archil mode                       |
| `run-on-fly.sh`  | Orchestrator — builds image, runs both scenarios on Fly, collects results |
| `setup-disks.ts` | Provisions Archil disks via SDK                                           |
| `Dockerfile`     | Benchmark container (node 22 + pnpm + archil CLI + fuse)                  |
