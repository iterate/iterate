# Approach 6: Mount FUSE at /mnt/persist, symlink dotfiles

**Result: PASS**

## What it tests

The working approach used in production. FUSE mounts at `/mnt/persist` (not over `~`). The Docker image has the repo + `node_modules` baked in on local disk. Only lightweight persistent state (dotfiles, `.gitconfig`, `.iterate/`, `.config/opencode/`) is symlinked from `/mnt/persist` into `~`.

## Why it works

- **Repo + node_modules on local disk**: no FUSE overhead for heavy I/O (pnpm, tsc, node)
- **FUSE only for small config files**: a handful of dotfiles = fast chown, fast reads/writes
- **Symlinks are transparent**: tools read/write `~/.gitconfig` normally, data persists to R2
- **Boot is fast**: seed dotfiles on first boot (~ms), create symlinks (~ms), done

## Running

```bash
docker build -t mishaland-06 .
docker run --rm --privileged mishaland-06
```

## Key output

The demo runs a full 11-phase boot sequence:
1. Start sshd (for loopback FUSE)
2. Mount FUSE at `/mnt/persist`
3. Seed dotfiles to persist volume (first boot only)
4. chown persist volume (fast — only ~10 files)
5. Create symlinks (`~/.gitconfig` -> `/mnt/persist/.gitconfig`, etc.)
6. Verify repo is on local disk
7. Node.js `require()` test
8. pnpm toolchain test
9. Write-through-symlink test (verify data reaches persist)
10. Total boot time (target: <30s)
11. pnpm install verification (should be instant — already on local disk)
