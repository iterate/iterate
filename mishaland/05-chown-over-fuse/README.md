# Approach 5: chown -R over FUSE

**Result: FAIL (EPERM)**

## What it tests

Attempts `chown -R` over a FUSE mount. When a machine reboots, files on the shared R2 bucket may be root-owned from a previous boot. Running `chown -R` to fix ownership is the obvious fix — but does it work over FUSE?

## Why it fails

SFTP (the transport behind sshfs) does not support `chown` — the SFTP server cannot change file ownership on behalf of other users. Every `chown` call fails with `EPERM: Operation not permitted`, regardless of whether you're root.

The demo creates 200 files on the FUSE mount and attempts `chown -R`. It also benchmarks local-disk `chown` as a baseline to show the approach wouldn't scale even if the permission issue were resolved (each chown is a separate FUSE round-trip).

## Running

```bash
docker build -t mishaland-05 .
docker run --rm --privileged mishaland-05
```

## Key output

- Local chown -R: milliseconds
- FUSE chown -R: fails with `EPERM: Operation not permitted` on every file
- Even if permissions were fixed, extrapolated time for 50K files would be minutes
