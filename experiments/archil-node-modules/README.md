# Archil node_modules benchmark

We're evaluating whether Archil can back `node_modules` for our AI coding agent sandboxes. Each sandbox is a Fly.io machine that runs `pnpm install` on startup. We want `node_modules` to persist across machine restarts via Archil, so cold starts are fast.

## Setup

- **Compute:** Fly.io machine in `lhr` (London), 4 shared vCPUs, 4 GB RAM
- **Archil disk:** `aws-eu-west-1` (Ireland), backed by Cloudflare R2 in Western Europe
- **Archil config:** Both `node_modules` and the pnpm content-addressable store are on the Archil mount (bind-mounted into the project directory). This is required because pnpm hardlinks files from the store into `node_modules` — both must be on the same filesystem.

## Results

| Workload                    | Packages | Files  | Local disk | Archil | Slowdown |
| --------------------------- | -------- | ------ | ---------- | ------ | -------- |
| Small (5 popular npm libs)  | 114      | 2,232  | 1.6s       | 6.5s   | **4x**   |
| Medium (typical TS devDeps) | 885      | 32,173 | 27s        | 25 min | **57x**  |

The slowdown scales super-linearly with file count. At 2K files, Archil is a manageable 4x slower. At 32K files, it's 57x slower. Our production monorepo has ~180K files in `node_modules` — extrapolating, that would likely take hours.

Raw output in [results.md](./results.md).

## What's slow

The bottleneck is the "added" phase of `pnpm install`. pnpm hardlinks thousands of small files from its content-addressable store into `node_modules`. Each file creation is a FUSE operation that round-trips to Archil's storage cluster. Downloads are fast — pnpm fetched 829/885 tarballs in seconds — but writing 32K files one-by-one through FUSE took 25 minutes.

Even a simple `find node_modules -type f | wc -l` took ~5 minutes on the Archil mount after the install completed.

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
