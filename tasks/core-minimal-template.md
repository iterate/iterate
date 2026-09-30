---
status: needs-grilling
size: medium
---

# Core bakes only a minimal project template

Left open by `mkdir core && mv apps/os core` (tasks/complete/2026-09-30-core-os.md). The platform's
build bakes every project template in `configs/` into the Worker, and a core test imports two of
them, so `configs/` is the one folder core still reaches outside itself for (the exception in
`.oxlintrc.json`'s core zone and core/AGENTS.md). The templates are first-party opinion:
`configs/default` installs the agents and voice apps.

The shape Misha and Claude talked about: core bakes only a minimal template (`configs/minimal`,
moved into core), and iterate's deploy tooling passes the opinionated ones (`default`, `heartbeat`)
into the build as an input, the way it passes the deployment. A self-host then starts projects
bare unless it supplies its own templates.

## Open questions

- Where core's minimal template lives (`core/os/templates/minimal`?), and whether it stays the
  default for a creation that names none.
- How the build takes the other templates: a folder path, or the files themselves.
- `core/os/src/project/default-template.test.ts` imports `default` and `heartbeat`: moves to
  `test/`.

## Checklist

- [ ] decide the above
- [ ] core bakes only the minimal template; the core zone drops its `configs/` exception
