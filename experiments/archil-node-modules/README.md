# Archil node_modules experiment

Can [Archil](https://archil.com) (a FUSE-mounted cloud filesystem backed by R2/S3) replace local `node_modules`?

## TL;DR

**No, not for `pnpm install`.** Writing 30K+ small files to an Archil mount is ~100x slower than local disk, even with same-region cloud compute. The 10K IOPS limit and per-file FUSE overhead make initial installs impractical.

Archil may still work for **reading** a pre-populated `node_modules` (e.g., sharing across machines), but we didn't benchmark that.

## What we tested

- **Repo:** [mmkal/expect-type](https://github.com/mmkal/expect-type) — 815 pnpm packages, ~30,906 files in `node_modules`
- **Baseline:** `pnpm install --frozen-lockfile` on local disk
- **Archil:** Same install, but `node_modules` and pnpm store are bind-mounted from an Archil FUSE mount
- **Environment:** Fly.io machine in `lhr` (London), Archil disk in `aws-eu-west-1` (Ireland), R2 bucket in Western Europe

## Results

| Scenario                     | pnpm install time | Packages added |
| ---------------------------- | ----------------- | -------------- |
| Local disk (Fly lhr)         | 15s               | 815/815        |
| Archil (Fly lhr → eu-west-1) | >300s (timeout)   | 165/815        |

See [results.md](./results.md) for raw output.

## Key learnings

1. **Archil must run in the same region as compute.** Our first attempt ran from a local Mac to a us-east-1 disk — every FUSE op crossed the public internet, making it ~1700x slower. Moving to same-region cloud (Fly lhr → eu-west-1) improved things ~5x, but still far too slow.

2. **The bottleneck is small-file writes, not downloads.** pnpm downloaded 683/815 packages quickly, but "adding" them (hardlinking into node_modules) was the chokepoint. Each of the ~30K files requires FUSE syscalls that round-trip to Archil's SSD cluster.

3. **Archil's API key is region-scoped.** A key created for `aws-us-east-1` returns 401 against the `aws-eu-west-1` control plane.

4. **The Archil SDK double-prefixes `key-`.** The `Archil` constructor prepends `key-` to the `apiKey` param, so strip it if your env var already includes the prefix.

5. **Deleting files on Archil is also slow.** An `rm -rf` of a populated `node_modules` on the FUSE mount took 18+ minutes from a local Mac. We switched to unique subdirectories per run to avoid cleanup.

## How to run

```bash
# Provision Archil disks (writes disk-config.json)
doppler run -- npx tsx setup-disks.ts

# Run locally (Docker) — mostly for testing the scripts
doppler run -- ./run.sh

# Run on Fly (proper benchmark)
docker buildx build --platform linux/amd64 -t registry.fly.io/iterate-sandbox:archil-bench --push .
doppler run -- fly apps create archil-bench-exp --org iterate
doppler run -- fly machine run registry.fly.io/iterate-sandbox:archil-bench \
  --app archil-bench-exp --region lhr \
  --vm-cpus 4 --vm-memory 4096 --vm-cpu-kind shared \
  -e MODE=baseline
# (then again with -e MODE=archil and the disk env vars from disk-config.json)
doppler run -- fly logs --app archil-bench-exp --no-tail
doppler run -- fly apps destroy archil-bench-exp --yes
```

## Files

- `benchmark.sh` — Docker entrypoint, runs baseline or archil scenario
- `setup-disks.ts` — Provisions Archil disks via SDK
- `disk-config.json` — Generated disk IDs and mount tokens (gitignored)
- `Dockerfile` — Benchmark container (node 22 + archil CLI + pnpm + fuse)
- `run.sh` — Local orchestration script
- `results.md` — Raw benchmark output
