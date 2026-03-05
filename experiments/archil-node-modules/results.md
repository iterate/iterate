# Archil node_modules benchmark results

Repo: https://github.com/mmkal/expect-type (815 packages, ~30,906 files in node_modules)

## Run 1: Local Mac (Docker/OrbStack) — invalid, included for reference

Archil disk in `aws-us-east-1`, client running on a Mac over the public internet.
This test is **not representative** of Archil's intended use — Archil is designed for
same-region cloud compute, not cross-internet access.

### baseline (local disk, Docker on Mac)

- git_clone: 0.6s
- pnpm_install: **3.7s**
- nm_files: 30,906

### archil (us-east-1 disk, Mac client over internet)

- Mounted successfully
- pnpm install stalled: 38 packages added in 5 minutes (of 815)
- Extrapolated completion: ~107 minutes
- Killed manually

## Run 2: Fly machine in `lhr` (London)

Archil disk in `aws-eu-west-1` (Ireland), Fly machine in `lhr` (London).
4 shared CPUs, 4GB RAM. R2 bucket in Western Europe (WEUR).

### baseline (local disk, Fly lhr)

- git_clone: 1.9s
- pnpm_install: **15.0s**
- nm_files: 30,906

### archil (eu-west-1 disk, Fly lhr client)

- Mounted in ~2s
- pnpm install: **TIMEOUT after 300s** — 165 of 815 packages added
- Extrapolated completion: ~25 minutes (~100x slower than baseline)
- Downloads were fast (683/815 downloaded), but "added" (writing to Archil) was the bottleneck

## Summary

| Scenario | Environment               | pnpm install         | Ratio vs baseline |
| -------- | ------------------------- | -------------------- | ----------------- |
| Baseline | Fly lhr, local disk       | 15.0s                | 1x                |
| Archil   | Fly lhr → eu-west-1 disk  | >300s (165/815 pkgs) | >20x (est ~100x)  |
| Baseline | Docker on Mac             | 3.7s                 | —                 |
| Archil   | Docker on Mac → us-east-1 | >300s (38/815 pkgs)  | >80x (est ~1700x) |

## Analysis

Even with proper same-region cloud deployment (Fly lhr → Archil eu-west-1), `pnpm install`
to an Archil-mounted `node_modules` is roughly **100x slower** than local disk.

The bottleneck is the "added" phase — pnpm hardlinks thousands of small files from its
content-addressable store into `node_modules`. Each file write is a FUSE syscall that
round-trips to Archil's SSD cluster. With ~30,000 files and a 10,000 IOPS limit, even
sub-millisecond per-op latency adds up to minutes.

This does **not** mean Archil is unsuitable for all `node_modules` use cases. It means
that the _initial install_ (creating 30K+ files) is slow. Subsequent reads of an
already-populated `node_modules` (e.g., running builds, importing modules) would benefit
from Archil's caching and could perform well. The value proposition for Archil with
node_modules would be: install once, then share the populated directory across machines.
