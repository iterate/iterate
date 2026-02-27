# Approach 3: FUSE over ~, bind-mount local node_modules on top

**Result: FAIL**

## What it tests

Mounts FUSE over `/home/testuser` (so `~` is persistent), then uses `mount --bind` to overlay local-disk `node_modules` on top of the FUSE-mounted `~/project/node_modules`. The idea: FUSE handles everything except the heavy `node_modules` dir, which stays on fast local disk.

## Why it fails

Inside Docker/Fly containers (which use overlayfs as the root filesystem), `mount --bind` on top of a FUSE path is unreliable:

- `mount --bind` returns exit code 0 (appears to succeed)
- But the target directory is empty — neither local nor FUSE content is visible
- Writes go to the wrong place (overlay upper dir, not local disk) or are silently lost

The kernel resolves the bind through the overlay's upper/lower layers rather than the live FUSE mount.

## Running

```bash
docker build -t mishaland-03 .
docker run --rm --privileged mishaland-03
```

## Key output

- `mount --bind` returns 0
- Target dir is empty or still shows FUSE content
- Writes to the bind path don't land on local disk
