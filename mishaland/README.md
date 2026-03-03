# Mishaland: Isolated Docker Demos

Standalone demos proving FUSE filesystem behaviors in Docker containers.
Each demo uses `sshfs` loopback to simulate a FUSE-backed remote store (archil, s3fs, rclone mount, etc.).

| Folder           | Demo                                    | Key Finding                               |
| ---------------- | --------------------------------------- | ----------------------------------------- |
| `sqlite-on-fuse` | SQLite running directly on a FUSE mount | Data loss, poor performance, WAL pitfalls |

## Running any demo

```bash
cd mishaland/<folder>
docker build -t mishaland-<folder> .
docker run --rm --privileged mishaland-<folder>
```
