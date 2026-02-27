# Mishaland: Archil FUSE Mount Approach Demos

Six isolated Docker demos proving why each approach to mounting an S3/R2-backed
FUSE filesystem for persistent home directories does or doesn't work.

We simulate the FUSE mount using `sshfs` (a FUSE filesystem) pointed at localhost,
which reproduces the same FUSE semantics and latency characteristics as archil.
No actual archil/R2 needed — the point is proving FUSE behavior.

## Approaches

| # | Folder | Approach | Result |
|---|--------|----------|--------|
| 1 | `01-fuse-over-home` | Mount FUSE directly over `~` then pnpm install | FAIL: extremely slow small-file writes |
| 2 | `02-fuse-overlayfs` | Use FUSE mount as overlayfs upperdir | FAIL: kernel rejects FUSE as upperdir |
| 3 | `03-fuse-bind-mount` | FUSE over `~`, bind-mount local node_modules on top | FAIL: bind mount unreliable on overlayfs |
| 4 | `04-symlink-node-modules` | FUSE over `~`, symlink node_modules to local disk | FAIL: pnpm mkdir fails with ENOTDIR |
| 5 | `05-chown-over-fuse` | chown -R over FUSE mount | FAIL: extremely slow (minutes for large trees) |
| 6 | `06-persist-mount-symlinks` | Mount FUSE at /mnt/persist, symlink dotfiles only | PASS: fast boot, writes on local disk |

## Running

Each folder has its own Dockerfile and test script. Run any demo:

```bash
cd mishaland/01-fuse-over-home
docker build -t mishaland-01 .
docker run --rm --privileged mishaland-01
```

All demos use `--privileged` for FUSE/mount operations.
