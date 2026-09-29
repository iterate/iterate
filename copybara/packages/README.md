# iterate/packages

iterate's packages outside the core: agents, voice, the AI linter, the GitHub sync, the CLI and the rest of `packages/`. Each builds on the `iterate` package, whose source is in [iterate/os](https://github.com/iterate/os0929). Every commit to iterate's main publishes them to [pkg.pr.new](https://pkg.pr.new), so any commit is installable:

```bash
npm i https://pkg.pr.new/iterate/iterate/@iterate-com/agents@<sha>
```

This repo is a read-only copy of those folders from iterate's own repo, made by [Copybara](https://github.com/google/copybara) after each deploy. Paths are the same in both, and each commit ends in `GitOrigin-RevId: <sha>`, naming the commit it came from.

- Found a bug, or want something? Open an issue.
- Have a fix in mind? Push it to a fork and link the compare view in an issue. Pull requests here would be overwritten by the next copy.

> **Experiment** ([iterate/iterate#3434](https://github.com/iterate/iterate/pull/3434)): this is iterate/packages0929, and the iterate/os link points at iterate/os0929.

This README lives in iterate's repo at `copybara/packages/README.md`.
