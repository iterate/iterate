# iterate/packages

The packages built on [iterate](https://iterate.com)'s platform ([iterate/core](https://github.com/iterate/core)) that anyone can install: the agents and voice apps, docs, GitHub sync and more, in `packages/`. Alongside them are the project templates that use them, in `configs/`. A self-hosted platform offers those templates by building with `--template "github:iterate/packages#main&path:configs/<name>"`.

This repo is a read-only copy of `packages/` and `configs/` from iterate's own repo, made by [Copybara](https://github.com/google/copybara) after each production deploy. Paths are the same in both, and each commit ends in `GitOrigin-RevId: <sha>`, naming the commit it came from.

- Found a bug, or want something? [Open an issue](https://github.com/iterate/packages/issues).
- Have a fix in mind? Push it to a fork and link the compare view in an issue. Pull requests here would be overwritten by the next copy.

This README lives in iterate's repo at `copybara/packages/README.md`.
