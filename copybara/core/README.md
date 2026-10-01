# iterate/core

The platform behind [iterate](https://iterate.com): the Cloudflare Worker that serves `os.iterate.com` (`core/os`), the `iterate` package (`core/lib`), which is the SDK that projects build on, the agents app and the `iterate` CLI, and the project templates every build offers (`core/configs`), which are also the plainest examples of configuring a project.

The packages built on it, and the templates that use them, are in [iterate/packages](https://github.com/iterate/packages).

To run your own, give your coding agent [`core/os/public/setup-prompt.md`](core/os/public/setup-prompt.md) ([self-hosting](core/os/SELF-HOSTING.md)).

Licenses: AGPL-3.0 ([LICENSE](LICENSE)), except the SDK (`core/lib`, npm `iterate`) and core's templates (`core/configs`), which are Apache-2.0 by the LICENSE in each folder.

This repo is a read-only copy of `core/` from iterate's own repo, made by [Copybara](https://github.com/google/copybara) after each production deploy. Paths are the same in both, and each commit ends in `GitOrigin-RevId: <sha>`, naming the commit it came from.

- Found a bug, or want something? [Open an issue](https://github.com/iterate/core/issues).
- Have a fix in mind? Push it to a fork and link the compare view in an issue. Pull requests here would be overwritten by the next copy.

This README lives in iterate's repo at `copybara/core/README.md`.
