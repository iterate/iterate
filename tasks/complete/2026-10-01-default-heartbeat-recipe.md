---
status: done
size: small
---

# The heartbeat is a recipe in the default template; the default is a build guarantee

**Status:** done, in review (iterate/iterate#3501). Heartbeat folded into default; the build fails without
`core/configs/default` and lists it first; the consent page and dash use that, no fallback.
Left: CI (e2e rows and browser specs weren't run locally).

Small cleanup after iterate/iterate#3496, which moved core's templates to `core/configs/` and made every build
bake them.

## 1. Fold `core/configs/heartbeat` into `core/configs/default`

`heartbeat/` is `default/` plus one `itx.schedules.set({ key: "heartbeat", when: { everyMs: 5 *
60_000 }, events: [{ type: "heartbeat" }] })` in the init case. A whole template for one call is a
lot of duplication to keep in step. Jonas's suggestion (2026-10-01): keep it in `default/` as a
commented-out example an agent can uncomment, e.g. for a project that checks on itself every five
minutes and repairs what it finds.

- [x] `default/worker.ts`: the `schedules.set` call, commented out, in the init case, saying what
      uncommenting it does and that commenting it out again doesn't cancel it _(below `installAgents(itx)`)_
- [x] delete `core/configs/heartbeat/` _(`git rm`)_
- [x] the places that name it: the `heartbeat` row in `test/vitest/os/config-templates.test.ts`,
      the root `typecheck:configs` script, `core/configs/README.md`, default's `AGENTS.md`, the
      comment in `test/vitest/agents/template.e2e.test.ts`, the `labelOf` example in
      `core/os/scripts/build.ts` _(all six; `git grep configs/heartbeat` is empty)_

## 2. Drop the "no default preset" fallbacks

The consent page (`core/os/src/consent-page.server.ts`) and the dash's New project sheet
(`apps/dash/src/routes/_auth/projects/index.tsx`) look for the preset whose folder is `default` and
fall back to the minimal config ("Blank" in the dash) when there is none. That fallback dates from
when templates were a build input and a bare core build had no default. Since iterate/iterate#3496, every build
bakes `core/configs/default`, so the fallback only runs in a fork that deleted the folder.

Decision: no fallback. A fork that deletes `default/` should learn at build time what depends on
it, not silently give every new signup a bare project with no agents.

- [x] `core/os/scripts/build.ts`: fail without `core/configs/default`; list it first (directory read
      order isn't guaranteed) _(`coreConfigTemplates`)_
- [x] type `templates` as a non-empty list with the default first: the generated
      `config-templates.d.ts` and `core/lib`'s `projects.templates()` _(`[Option, ...Option[]]`; survives the dash's RPC and loader types)_
- [x] consent page: `templates[0]`; drop the search and the stale `--template` comment _(`createConsentProject`)_
- [x] dash: list the presets with the default preselected; drop the `""` option, "Blank" and the
      filter _(`templateFields` returns the default's reference when nothing is named)_
- [x] `core/os/public/setup-prompt.md` still says "Blank" in the dash _(now `minimal`)_

## Also: `?template=<name>` in the dash

The dash matches `?template=<name>` against `configs/<name>`, but core's templates moved to
`core/configs/<name>` in iterate/iterate#3496, so the PR preview's "minimal" quick-launch link opens with Default
selected. Match on the folder name instead.

- [x] `templateFields` matches the preset's folder name _(`?template=default` needs no special case now either)_
