# SQLite on FUSE: Why it doesn't work

Demonstrates why running SQLite directly on a FUSE-backed filesystem (archil,
s3fs, rclone mount, etc.) leads to data loss, poor performance, and reliability
issues.

## The problem

SQLite assumes a POSIX-compliant local filesystem with:

- Reliable `fsync` (data hits disk when fsync returns)
- Working file locking (`fcntl` locks)
- Atomic rename operations
- Low-latency I/O for WAL checkpoints

FUSE filesystems backed by remote storage (S3, R2) violate these assumptions:

- `fsync` may return before data reaches the backend (write-behind cache)
- File locks may not be enforced across mount points
- Every I/O operation is a network round-trip
- WAL files can become orphaned or stale

## What this demo proves

| Test                   | What happens                                               |
| ---------------------- | ---------------------------------------------------------- |
| **WAL visibility**     | Copying `.db` without `-wal`/`-shm` loses uncommitted data |
| **Performance**        | 1000 inserts: FUSE is 5-20x slower than local disk         |
| **Crash durability**   | kill -9 during FUSE writes = lost transactions             |
| **Concurrent writers** | SQLITE_BUSY errors and data loss from broken locking       |

## How it works

Uses `sshfs` (a FUSE filesystem) pointed at localhost via SSH loopback.
This reproduces the same FUSE semantics as any remote-backed FUSE mount
without needing archil, S3, or R2 credentials.

## Running

```bash
docker build -t mishaland-sqlite-fuse .
docker run --rm --privileged mishaland-sqlite-fuse
```

Requires `--privileged` for FUSE mount operations.

## The safe alternative

Instead of running SQLite directly on FUSE:

1. Keep SQLite databases on **local disk** (fast, reliable)
2. Periodically run `sqlite3 /path/to/db ".backup '/path/to/snapshot.db'"` —
   this creates a consistent, checkpointed copy safe for transfer
3. Copy the snapshot to durable storage (R2, S3, FUSE mount, etc.)
4. On machine replacement, restore the snapshot to local disk before starting
   the application

This is exactly what `archil-mount.sh` does for opencode, events-service,
and daemon databases.
