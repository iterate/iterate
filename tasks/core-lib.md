---
status: in-progress
size: large
---

# `packages/iterate` → `core/lib`, with the CLI merged in

Pre-work PR 3 for the public `iterate/os` copy. The SDK (npm `iterate`) moves into core beside the
platform, and the CLI (`@iterate-com/cli`) stops being its own package: its source, bin and macOS
menu bar become part of `iterate`. Afterwards `packages/iterate` is no longer an exception to the
core boundary; `configs/` is the only one left.

Status: implemented, waiting on CI. The SDK is `core/lib` and the CLI is part of it; the lint
boundary has one exception left (`configs/`); every local check passes (typecheck, lint, knip,
format, `iterate`'s tests with the CLI's, core/os's, `test/`'s, a build and the bin from source and
built). Left: CI green.

## Layout

```text
core/
├── os/                 # the platform (PR 2)
└── lib/                # was packages/iterate: npm `iterate`
    ├── bin/iterate.js  # was packages/cli/bin/iterate.js: `npx iterate`
    ├── menubar/        # was packages/cli/menubar
    └── src/
        ├── cli/        # was packages/cli/src, and its README
        └── …           # the SDK, as before
```

## Decisions

Misha chose the merge ("merged into iterate; we'll drop the clack and orpc deps soon anyway"). The
rest are my calls:

- **`iterate` gains the `iterate` bin** and the CLI's dependencies (`@clack/prompts`,
  `@orpc/server`, `trpc-cli`; `capnweb`, `oauth4webapi`, `ws`, `zod` it already has). Its engines
  floor rises to the CLI's, Node 22.18.
- **The CLI imports the SDK by relative path**, not `iterate/*`: it is the same package now, and a
  package importing its own name is resolved differently by Node, TypeScript and Vite. The CLI's
  build entry bundles the SDK modules it uses, as the other Node entries do.
- **A `tsconfig.cli.json`** types the CLI against Node alone, as packages/cli's tsconfig did; the
  SDK's tsconfigs exclude it.
- **The menu bar finds the package root by walking up to `bin/iterate.js`**, since the CLI now runs
  from `src/cli/` in the repo and from a `dist/` chunk once built.
- **Lint:** the core boundary drops its `packages/iterate` exception. The platform line (the SDK
  and the apps never import the platform) now covers `core/lib` too.
- **`@iterate-com/cli` stops publishing.** npm keeps its last version; telling its users to run
  `npx iterate` instead is a follow-up.
- `packages/iterate` → `core/lib` is two levels deep either way, so paths are rewritten as text.

## Checklist

- [x] `git mv packages/iterate core/lib`; the CLI's `src`, `bin`, `menubar` and README into it
- [x] `iterate`'s `package.json` (bin, files, dependencies, engines, typecheck), tsdown entry,
      tsconfigs; packages/cli's own config files removed
- [x] every mention rewritten: workspace, knip, oxlint, workflows (pkg.pr.new's filters and publish
      list, path filters), docs, the commit hook, `test/`'s CLI e2e
- [x] lint: the boundary without the exception, the platform line over `core/lib`, and their tests
- [ ] typecheck, lint, knip, format, `iterate`'s tests (the CLI's included), a build and
      `node core/lib/bin/iterate.js --help`; CI green

## Out of scope

- Dropping `@clack/prompts` and `@orpc/server`.
- A deprecation release of `@iterate-com/cli`.
- Core baking only a minimal template (PR 2's open item).

## Implementation notes

- The move script again (PR 2's, with two fixes: an import keeps its `./` before a dot-folder, and
  a markdown link keeps its bare style). Its first run let the catch-all `packages/cli` mapping
  override the specific ones (the CLI's `src`, `bin` and `menubar` landed under `src/cli/`); the
  first matching move wins now, and the run was redone from a clean tree.
- The catch-all maps prose `packages/cli` to `core/lib/src/cli`; four mentions that meant the
  package, or said `src/x.ts` after it, were fixed by hand (the CLI e2e's build dir among them).
- `tasks/core-os.md` was still in `tasks/` when #3487 merged: moved to `complete/` here, and its
  open item became `tasks/core-minimal-template.md`, which the lint message and core/AGENTS.md link.
- knip's root `ignoreDependencies` no longer needs the bin's package: the root imports `iterate`.
