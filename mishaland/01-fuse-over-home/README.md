# Approach 1: Mount FUSE over ~ then pnpm install

**Result: FAIL**

## What it tests

Mounts a FUSE filesystem (sshfs loopback) directly over `/home/testuser`, then runs `pnpm install` on the real iterate repo. This is the most obvious approach — just make `~` persistent via FUSE.

## Why it fails

pnpm install writes ~50K small files into `node_modules`. On a FUSE mount, every `open`/`write`/`close`/`chmod` is a round-trip through the kernel FUSE module to the userspace daemon. Even at 1-2ms per op, 50K files x ~5 ops x 1.5ms = ~6 minutes minimum.

In practice with archil (S3/R2-backed), the install either:
- Times out (>600s readiness probe deadline)
- Fails with `ERR_PNPM_JSON_PARSE` due to I/O errors mid-write

The demo runs a baseline `pnpm install` on local disk first, then the same install over FUSE with a 120s timeout.

## Running

```bash
docker build -t mishaland-01 .
docker run --rm --privileged mishaland-01
```

## Key output

- Local install: ~30-60s
- FUSE install: times out or takes 10+ minutes
