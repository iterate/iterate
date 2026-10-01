---
status: later
size: small
---

# Core copies from outside with codegen, kept in sync

Core builds from a clone of itself, so it imports nothing outside `core/`. When core genuinely needs
something that lives outside, the way in could be a copy that a lint rule keeps in sync:
[eslint-plugin-codegen](https://github.com/mmkal/eslint-plugin-codegen) writes the outside file's
content into a core file and fails lint when the two drift. The clone of core still holds every byte
it needs.

This should be exceptional and rare; most things belong on one side of the line.

First candidate: core's minimal config (`core/os/src/project/minimal-config.ts`, its `package.json`
and `worker.ts` as strings) generated from `configs/minimal/`, which stays as iterate's preset
(Misha, 2026-10-01: keep `configs/minimal`).

## Checklist

- [ ] eslint-plugin-codegen as an oxlint JS plugin (`.oxlintrc.json` `jsPlugins`), or the codegen CLI
      in CI if the plugin won't run under oxlint
- [ ] `minimal-config.ts`'s two files generated from `configs/minimal/{package.json,worker.ts}`
- [ ] a line in `core/AGENTS.md`: the pattern, and that it is the exception
