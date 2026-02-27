# Approach 3: FUSE over ~, bind-mount local node_modules on top

**Result: FAIL**

## What it tests

Mounts FUSE at `/mnt/fuse-home` (simulating archil), creates content **at runtime through the FUSE mount** (not baked into the image), then uses `mount --bind` to overlay local-disk `node_modules` on top. The idea: FUSE handles everything except the heavy `node_modules` dir, which stays on fast local disk.

## Why it fails

Inside Docker/Fly containers (which use overlayfs as the root filesystem), `mount --bind` over a FUSE path resolves through the overlay's upper/lower layers, not the live FUSE mount:

- `mount --bind` returns exit code 0 (appears to succeed)
- Local content may appear at the mount point (giving the illusion it worked)
- But **writes through the bind path go to the overlay upperdir**, not to local disk
- After unmounting the bind, FUSE content is intact — the bind never touched it
- Data written through the bind is ephemeral (lost on container restart)

Previous versions of this test baked content into the Docker image, which masked the problem — the overlay cache made the bind appear to work. Creating content at runtime through FUSE exposes the real behavior.

## Running

```bash
docker build -t mishaland-03 .
docker run --rm --privileged mishaland-03
```

## Key output

- `mount --bind` returns 0
- Writes through the bind path land in overlay upperdir, not local disk
- After unmounting bind, FUSE content is unaffected (bind never routed to it)
- `/proc/mounts` shows the bind device as `overlay`, not a local filesystem
