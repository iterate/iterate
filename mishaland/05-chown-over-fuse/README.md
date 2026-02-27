# Approach 5: chown -R over FUSE

**Result: FAIL (impractical)**

## What it tests

Benchmarks `chown -R` over a FUSE mount vs local disk. When a machine reboots, files on the shared R2 bucket may be root-owned from a previous boot. Running `chown -R` to fix ownership is the obvious fix — but how long does it take over FUSE?

## Why it fails

Each `chown` call is a separate FUSE round-trip (getattr + setattr per file). For the iterate repo (~50K files including node_modules), this takes 3+ minutes over FUSE vs milliseconds on local disk.

The demo copies up to 3000 files to the FUSE mount and benchmarks `chown -R` with a 120s timeout. It also benchmarks local-disk `chown` as a baseline.

## Running

```bash
docker build -t mishaland-05 .
docker run --rm --privileged mishaland-05
```

## Key output

- Local chown -R: milliseconds
- FUSE chown -R (3000 files): tens of seconds or timeout
- Extrapolated to 50K files: minutes — too slow for machine boot
