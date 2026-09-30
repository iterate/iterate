# core

What goes public as `iterate/os`: the platform Worker (`os/`), and npm `iterate` (`lib/`), which is
the SDK and the `iterate` CLI.

- **Core builds from a clone of itself.** Nothing in `core/` imports outside `core/`; outside code may
  import core, never the reverse. One exception remains: the project templates in `configs/`,
  which the build bakes in (`tasks/core-minimal-template.md`). `.oxlintrc.json` enforces it
  (`lint/oxlintrc-core-boundary.test.ts`), and `os/scripts/build.test.ts` checks the build.
- **Internal tooling stays outside:** iterate's deploys and previews (`scripts/os/`), the end-to-end
  and browser tests (`test/`), tasks and CI.
