# core

What goes public as `iterate/os`: the platform Worker (`os/`) and the project templates it bakes in
(`configs/`). `packages/iterate` joins as `lib/`.

- **Core builds from a clone of itself.** Nothing in `core/` imports outside `core/`; outside code may
  import core, never the reverse. `packages/iterate` is the one exception until it moves here.
  `.oxlintrc.json` enforces it (`lint/oxlintrc-core-boundary.test.ts`), and
  `os/scripts/build.test.ts` checks the build.
- **Internal tooling stays outside:** iterate's deploys and previews (`scripts/os/`), the end-to-end
  and browser tests (`test/`), tasks and CI.
