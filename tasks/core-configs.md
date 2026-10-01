---
status: in-progress
size: large
base: core-copy (#3493)
---

# Core's configs live in core; agents is `iterate/agents`

From Misha and Jonas's Tuple call (2026-10-01): configs that depend only on core go in
`iterate/core` as starter examples and documentation; the default config must depend on nothing
outside core. Stacked on #3493 (the public copies), which predates the call and still bakes
`configs/default` and `configs/heartbeat` from iterate/packages with `--template`.

Status: spec only.

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

- [ ] `packages/agents` → `core/lib/src/agents/` (its tests too), `iterate/agents*` exports,
      tsdown entries, platform entries; internal imports relative
- [ ] drop `agentsVersion`/`upgradeAgents` and the Agents app's upgrade widget
- [ ] importers move to `iterate/agents*`: apps/agents, apps/dash, packages/voice, test/
- [ ] `configs/{default,heartbeat,minimal}` → `core/configs/`, without voice; `configs/voice`
- [ ] core's build bakes `core/configs/*` (reference from `origin` and HEAD); `minimal-config.ts`
      gone; iterate's tooling (`scripts/os/config-templates.ts`) passes only `configs/*`
- [ ] Copybara: README of each copy, the PR check's folder gets an `origin`
- [ ] setup prompt: a bare build
- [ ] pkg.pr.new stops publishing agents; workflow path filters, `published-package-commit.ts`,
      preview paths
- [ ] tests: config-templates, the agents template e2e, voice rows on the Voice preset
- [ ] docs: READMEs, `core/AGENTS.md`, `docs/`, the fix-stream skill
- [ ] `tasks/core-codegen-sync.md`: its first candidate is gone
- [ ] typecheck, lint, knip, format, unit tests

## Out of scope

- Migrating projects pinned to `@iterate-com/agents` to `iterate/agents`.
- Heartbeat folded into `default`.
- Jonas's starter configs (bring your own OAuth, a single long-running agent, named agents).
- Voice in its own repo; iterate/private; archiving iterate/iterate.
- The shadcn registry and the stream renderer's home.
