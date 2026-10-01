# iterate/core

The platform behind [iterate](https://iterate.com): the Cloudflare Worker that serves `os.iterate.com` (`core/os`), and the `iterate` package (`core/lib`), which is the SDK that projects build on and the `iterate` CLI.

The packages built on it, and the project templates, are in [iterate/packages](https://github.com/iterate/packages).

To run your own, give your coding agent [`core/os/public/setup-prompt.md`](core/os/public/setup-prompt.md) ([self-hosting](core/os/SELF-HOSTING.md)).

This repo is a read-only copy of `core/` from iterate's own repo, made by [Copybara](https://github.com/google/copybara) after each production deploy. Paths are the same in both, and each commit ends in `GitOrigin-RevId: <sha>`, naming the commit it came from.

- Found a bug, or want something? [Open an issue](https://github.com/iterate/core/issues).
- Have a fix in mind? Push it to a fork and link the compare view in an issue. Pull requests here would be overwritten by the next copy.

This README lives in iterate's repo at `copybara/core/README.md`.
