---
status: review
size: large
base: main
---

# Core's configs live in core; agents is `iterate/agents`

From Misha and Jonas's Tuple call (2026-10-01): configs that depend only on core go in
`iterate/core` as starter examples and documentation; the default config must depend on nothing
outside core. It follows #3493 (the public copies, merged), which predates the call and baked
`configs/default` and `configs/heartbeat` from iterate/packages with `--template`.

Status: implemented, rebased on main after #3493 merged, checked locally; no PR yet (Misha: "no PR"). Agents is `iterate/agents`,
core's configs live in `core/configs` and every build bakes them, voice is the `configs/voice`
template. Typecheck, lint, knip, format, the touched packages' unit tests, the Workers rows and the
agents e2e rows pass locally. Not run: CI, a preview, and the deployed-only voice rows and the
voice browser spec, which now pick the Voice preset.

## Decisions

- **One PR** (Misha): moving agents into core and moving the configs land together.
- **Agents → `core/lib/src/agents/`, exported as `iterate/agents`** (Misha agreed, over
  `core/os/<something>/agents`): the loader already links `iterate/*` to the deployment's own build
  (core/os `module-resolution.ts`), so a config imports agents from the platform with no
  pkg.pr.new pin. Subpaths: `iterate/agents`, `/install`, `/contract`, `/processor`,
  `/codemode-format`. The first three are platform entries (core/os `scripts/build.ts`
  `PLATFORM_ENTRIES`): a config and the voice package import them in a loaded worker.
- **Agents upgrades with the platform**, like `iterate/sdk`: there is no per-project pin any more.
  So `agentsVersion`, `upgradeAgents` and the Agents app's upgrade widget go. `@iterate-com/agents`
  stops publishing to pkg.pr.new.
- **`core/configs/{default,heartbeat,minimal}`**, moved from `configs/`. `default` and `heartbeat`
  keep agents and email-to-agent and lose voice; their `package.json` lists no dependencies.
- **`configs/voice`** (outside core, copied to iterate/packages): today's default, voice included.
  The voice e2e rows and browser spec name the Voice preset.
- **Core's build bakes `core/configs/*` itself**, whatever else it is given. `--template` stays for
  templates from outside core. A bare `pnpm --filter os build` offers core's configs. This undoes
  part of #3492, where a bare build offered no presets.
- **`core/os/src/project/minimal-config.ts` goes**: a creation that names no template is seeded
  from `core/configs/minimal`, baked by the build.

## Assumptions (mine, Misha didn't say)

- **A core config's reference** (the preset's name, its key and the seed commit's message) is
  `github:<owner>/<repo>#<HEAD>&path:core/configs/<name>`, with the repository read from the
  checkout's `origin` remote. That is iterate/iterate in iterate's own builds and iterate/core in a
  self-host's clone, so the reference resolves on GitHub either way. A build whose `origin` is not
  a GitHub repository fails and says so. The copy's PR check adds iterate/core as the `origin` of
  the folder it writes, which is what a clone has.
- **Heartbeat stays its own preset.** Folding it into `default` as a commented-out recipe (Jonas's
  idea) is a separate change: it touches the scheduled-append and residency tests.
- **os.iterate.com's Default preset loses voice.** Jonas said nobody relies on the default; Voice
  is a preset of its own.
- **Projects already pinned to `@iterate-com/agents`** keep running their pinned build. Nothing
  migrates them, and the Agents app no longer offers them an upgrade.

## Checklist

- [x] `packages/agents` → `core/lib/src/agents/` (its tests too), `iterate/agents*` exports,
      tsdown entries, platform entries; internal imports relative _(all five subpaths are platform
      entries, per `PLATFORM_ENTRIES`' "every subpath that runs in workerd")_
- [x] drop `agentsVersion`/`upgradeAgents` and the Agents app's upgrade widget _(`upgradeVoice`
      now documents the upgrade protocol itself)_
- [x] importers move to `iterate/agents*`: apps/agents, apps/dash, packages/voice, test/
- [x] `configs/{default,heartbeat,minimal}` → `core/configs/`, without voice; `configs/voice`
- [x] core's build bakes `core/configs/*` (reference from `origin` and HEAD); `minimal-config.ts`
      gone; iterate's tooling (`scripts/os/config-templates.ts`) passes only `configs/*`
      _(`coreConfigTemplates` in core/os `scripts/build.ts`; the generated module exports
      `minimalConfigFiles`)_
- [x] Copybara: README of each copy, the PR check's folder gets an `origin`
- [x] setup prompt: a bare build _(and an "Adding voice" section: the setup agent adds voice to the user's existing config over MCP, rather than creating a second project)_
- [x] pkg.pr.new stops publishing agents; workflow path filters, `published-package-commit.ts`,
      preview paths _(and the PR body's template quick-launch links cover both folders)_
- [x] tests: config-templates, the agents template e2e, voice rows on the Voice preset
      _(`preset(label)` in test/helpers/project-host.ts; `createFixture(…, { preset })`)_
- [x] docs: READMEs, `core/AGENTS.md`, `docs/`, the fix-stream skill
- [x] `tasks/core-codegen-sync.md`: its first candidate is gone
- [x] typecheck, lint, knip, format, unit tests _(locally; scripts/'s toolchain and tracing rows
      fail on macOS's bash 3.2 before and after)_
- [ ] CI green, and a preview's e2e rows, the deployed-only voice rows included

## Out of scope

- Migrating projects pinned to `@iterate-com/agents` to `iterate/agents`.
- Heartbeat folded into `default`.
- Jonas's starter configs (bring your own OAuth, a single long-running agent, named agents).
- Voice in its own repo; iterate/private; archiving iterate/iterate.
- The shadcn registry and the stream renderer's home.

## Implementation notes

- **The workspace config for agent tests got simpler.** `test/vitest/agents-workers/agents-workspace-config.ts`
  used to copy the agents source files into a test config (vite `?raw` imports). Now its `agents.ts`
  re-exports `iterate/agents`, which the platform under test serves from this checkout's build.
  `raw-imports.d.ts` went with it. install.e2e's "the agents' code changes" step edits `agents.ts`.
- **The template e2e row no longer waits on pkg.pr.new.** It took ~6 s locally, so its 90 s
  timeout and 60 s wait (sized for esm.sh's first load of a pkg.pr.new build) went.
- **A no-template creation now also gets `AGENTS.md` and `tsconfig.json`**, since it is seeded
  from the `core/configs/minimal` folder rather than two strings.
- **Kit and the Voice app need a voice project now.** `ensureVoiceAgent` refuses a config that
  doesn't install voice, so a project on Default can't set up voice; the Voice preset can.
- `core/lib/src/pkg-pr-new.test.ts` keeps `@iterate-com/agents` as its example package name: the
  rows compare two packages, and voice is already the other one.
- Test fixtures that only needed a pkg.pr.new package name (`core/os/src/project/templates.test.ts`,
  `packages/docs/src/install.test.ts`, `scripts/os/preview-packages.test.ts`) name
  `@iterate-com/voice`, which still publishes.
