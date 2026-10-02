# iterate/iterate (archived)

This was iterate's monorepo from September 2025 to 2026-10-02. It's now a read-only archive: about 3,100 commits, every pull request and issue, and the code as of that day.

iterate is now developed in one private repo, [iterate/private](https://github.com/iterate/private), which only the iterate team can see. Parts of it are copied, one way, to two public repos:

- [iterate/core](https://github.com/iterate/core): the platform. The Worker behind os.iterate.com (`core/os`), the `iterate` SDK and CLI (`core/lib`), and the project templates every build offers (`core/configs`). Start here to self-host.
- [iterate/packages](https://github.com/iterate/packages): the first-party apps (dash, notes, docs, agents, voice and more), what you install into a project (voice, docs, GitHub sync, the AI linter), the shadcn component registry (`packages/ui`), and the templates that use them (`configs/`).

Paths match: `core/os/src/...` here is `core/os/src/...` in iterate/core. The rest (`internal-packages/`, `test/`, `scripts/`, `docs/`, `tasks/`, CI) isn't copied, so this archive is its last public version. A few apps have repos of their own, like [iterate/kit](https://github.com/iterate/kit) and iterate/mobile.

## Why

We're following a setup to similar to Ryan Dahl's [for celld](https://x.com/rough__sea/status/2092091242377265562): the public repo is a lean export, and the tests, CI, ops scripts and working notes live in a private repo. Agents running on iterate read iterate/core to understand the platform they run on, and a small repo is easier to read than this one.

## If you used this repo

- **Links** to files here still work, and show the code as of 2026-10-02. The current version is at the same path in iterate/core or iterate/packages.
- **Package builds** from this repo (`https://pkg.pr.new/iterate/iterate/...`) stop updating, and pkg.pr.new removes old builds after a while. New builds are at `https://pkg.pr.new/iterate/private/...`.
- **Self-hosting**: give your coding agent https://os.iterate.com/setup-prompt.md. It clones iterate/core.
- **Bugs and requests**: open an issue on [iterate/core](https://github.com/iterate/core/issues) or [iterate/packages](https://github.com/iterate/packages/issues). Got a fix? Push it to a fork and link the compare view in the issue.

The last commit here renames the CI folders to `.depot.archived/` and `.github.archived/`, so nothing in this repo runs, but you can still read how it was wired. Licenses are unchanged: AGPL-3.0 ([LICENSE](LICENSE)), except folders with an Apache-2.0 LICENSE of their own (the SDK, the packages and the templates).
