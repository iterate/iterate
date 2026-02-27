# Approach 2: FUSE as overlayfs upperdir

**Result: FAIL**

## What it tests

Mounts a FUSE filesystem (sshfs), then tries to use it as the `upperdir` for an overlayfs mount. The idea: overlay local files (lower) with a FUSE-backed writable layer (upper), so writes persist to R2 while reads stay fast.

## Why it fails

The kernel rejects FUSE filesystems as overlayfs upper layers. overlayfs requires the upper filesystem to support `trusted.*` xattrs and certain inode operations that FUSE does not provide. Only real local filesystems (ext4, xfs, tmpfs) are accepted.

The `mount -t overlay` call fails immediately with a kernel error.

## Running

```bash
docker build -t mishaland-02 .
docker run --rm --privileged mishaland-02
```

## Key output

```
mount -t overlay overlay \
  -o lowerdir=/opt/lower-dir,upperdir=/opt/fuse-staging/upper,workdir=/opt/fuse-staging/work \
  /opt/merged
# => FAILS with kernel error about unsupported upper filesystem
```
