# Approach 4: Symlink node_modules to local disk

**Result: FAIL**

## What it tests

Instead of FUSE-mounting `~`, keeps `~` on FUSE but creates a symlink `node_modules -> /var/local-node-modules` (on local disk). The idea: pnpm follows the symlink and writes to fast local disk while the rest of `~` persists via FUSE.

## Why it fails

pnpm calls `mkdir` on the `node_modules` path during install. When `node_modules` is a symlink, `mkdir` gets `ENOTDIR` (or `EEXIST`) because the path is a symlink, not a directory. pnpm doesn't follow symlinks for its root `node_modules` directory.

The demo first runs a baseline `pnpm install` (works), removes `node_modules`, creates the symlink, then runs `pnpm install` again (fails).

## Running

```bash
docker build -t mishaland-04 .
docker run --rm --privileged mishaland-04
```

## Key output

- Baseline pnpm install: succeeds
- pnpm install with symlinked node_modules: fails with `ENOTDIR`/`EEXIST`
