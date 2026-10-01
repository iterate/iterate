# core

What goes public as `iterate/core`: the platform Worker (`os/`), and npm `iterate` (`lib/`), which is
the SDK and the `iterate` CLI.

- **Core builds from a clone of itself.** Nothing in `core/` imports outside `core/`; outside code may
  import core, never the reverse. `.oxlintrc.json` enforces it (`lint/oxlintrc-core-boundary.test.ts`),
  and `os/scripts/build.test.ts` checks the build.
- **Project templates are the build's input** (`os/scripts/build.ts` `--template`): a project
  created with none gets core's minimal config (`os/src/project/minimal-config.ts`). iterate's own
  (`configs/`) come from its deploy tooling (`scripts/os/config-templates.ts`).
- **Internal tooling stays outside:** iterate's deploys and previews (`scripts/os/`), the end-to-end
  and browser tests (`test/`), tasks and CI.
