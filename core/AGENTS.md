# core

What goes public as `iterate/core`: the platform Worker (`os/`), npm `iterate` (`lib/`), which is
the SDK, the agents app (`iterate/agents`) and the `iterate` CLI, and the project templates every
build offers (`configs/`).

- **Core builds from a clone of itself.** Nothing in `core/` imports outside `core/`; outside code may
  import core, never the reverse. `.oxlintrc.json` enforces it (`lint/oxlintrc-core-boundary.test.ts`),
  and `os/scripts/build.test.ts` checks the build.
- **Core's configs** (`configs/`) are the templates every build offers, and the documentation of
  how a project is configured: each depends on nothing outside core (`iterate/*` and `zod` come from
  the platform). A project created with no template gets `configs/minimal`. Templates that need
  other packages are the build's input (`os/scripts/build.ts` `--template`): iterate's (the
  repository's `configs/`) come from its deploy tooling (`scripts/os/config-templates.ts`).
- **Internal tooling stays outside:** iterate's deploys and previews (`scripts/os/`), the end-to-end
  and browser tests (`test/`), tasks and CI.
- **No ids or keys**, here or in `packages/`, tests included: no UUID, account id, key, or long hex,
  base64 or digit string (`lint/public-copies.test.ts`). An id goes in `envs.ts`, a secret in
  Doppler; a test uses an obvious fake (`aaaaabbbbbccccc111112222233333aaaaabbbbb`).
