---
status: in-progress
size: medium
---

# Core bakes only a minimal project template

The last thing core reaches outside itself for: the platform's build bakes every template in
`configs/` into the Worker, and a core test imports two of them. The templates are first-party
opinion (`configs/default` installs the agents and voice apps), so they stay outside core, and the
build takes them as an input instead. Core then imports nothing outside itself, and the lint
exception goes.

Status: not started.

## Decisions (Misha, 2026-09-30 / 10-01)

- **A creation that names no template gets core's minimal config**: two files (`package.json` and
  a `worker.ts` that serves a homepage), defined as strings in core's code. Not `configs/default`.
- **Templates are a build input**, not a folder core reads. `build({ templates })` takes each
  template as a reference and its files; the CLI takes repeated
  `--template 'github:<owner>/<repo>#<ref>&path:<dir>'`, which the build downloads (pinned to a
  commit, with the platform's own GitHub template downloader). No template input: only the
  minimal config is built in, and the dash lists no presets.
- **iterate's own deploys, previews and test setups pass `configs/*`**, as they bake it today:
  each template's tracked files, its agents and voice pinned to this checkout's pkg.pr.new build,
  under the reference `github:iterate/iterate#<sha>&path:configs/<name>`. That tooling, and the
  "which pkg.pr.new build is this checkout's" logic it needs (`published-package-commit.ts`), live
  outside core, in `scripts/os/`.
- **The dash** offers the presets the platform lists, `default` among them, and preselects the one
  whose folder is `default` when there is one. Its empty choice is now "Blank" (the minimal
  config). `?template=<name>` still picks a preset by folder name.
- **Self-host** (`core/os/public/setup-prompt.md`): a bare build bakes only the minimal config; to
  offer iterate's templates, build with `--template` for each (from iterate/iterate while it is
  public; from a public copy later).
- `pnpm --filter os build` passes its arguments to `build.ts`, which runs vite itself.

## Checklist

- [ ] core's minimal config in code; the seed uses it when no template is named
- [ ] `build({ templates })` and `--template`; the build reads nothing outside core
- [ ] `scripts/os/`: the configs/ templates as build input, `published-package-commit.ts` moved;
      deploy, preview and the test global setups pass them
- [ ] the templates' own tests (`default-template.test.ts`, `templates.test.ts`) move to `test/`
- [ ] tests that need agents from their project's seed name the `default` preset
- [ ] the dash: presets include `default`, preselected; "Blank" for none
- [ ] lint: the core zone without its `configs/` exception; `core/AGENTS.md`
- [ ] the self-host setup prompt
- [ ] typecheck, lint, knip, format, tests; CI green, including the preview and its e2e rows

## Out of scope

- A public home for the templates (`iterate/packages`), and switching the references to it: when
  iterate/iterate goes private.
- Serving agents and voice builds from somewhere other than pkg.pr.new.

## Implementation notes
