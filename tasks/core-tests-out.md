---
status: in-progress
size: large
---

# apps/os keeps only simple unit tests; the rest move to `test/`

PR 3 of the e2e move, redefined with Misha after auditing what apps/os takes from
`packages/shared/src/test-support`. In the new world apps/os keeps simple in-process unit tests,
and every meaningful test lives outside core, in `test/`. Every test-support import in core came
from a test that isn't simple, so moving those tests out removes the imports.

Status: code done and checked locally; CI to confirm.

## Decisions

- The Workers suite (`apps/os/__workers-tests__`, and the Agents app's two files apps/os's
  `workers` project also ran) moves to `test/vitest/os-workers/` and `test/vitest/agents-workers/`,
  a `workers` project in `test/vitest.config.ts`. (Reverses PR 1's "`__workers-tests__` stays in
  core".)
- The in-process integration tests move to `test/vitest/os/`: the two Cloudflare-fault pins that
  boot a bare workerd, the memory pins (Node children at 128 MiB), the tunnelled Vite HMR test,
  and the repo facet against the fake git server. A `node` project runs them with the helpers'
  own tests.
- `apps/os/test-support/` (the fakes and fixtures those tests share with the e2e suite) moves to
  `test/helpers/`.
- The `cloudflare:workers` shim that unit tests alias belongs to core:
  `packages/iterate/src/test-support/cloudflare-workers-shim.ts`; the other workspaces point at it.
- Core's vitest configs (apps/os, packages/iterate) import no reporter: they add the reporters
  named in `VITEST_EXTRA_REPORTERS`, which CI's Test job sets to iterate's telemetry reporter
  (option (a); (b), exempting core from the telemetry rule, if this turns out complicated).
- Root `pnpm test` builds apps/os once before the workspaces run, since the Workers suite runs
  its built worker; the packages' own test scripts build nothing, so no two builds race.
- The rest of `packages/shared/src/test-support` stays: once core stops importing it, only
  workspaces outside core and CI scripts use it.

## Checklist

- [x] the moves, every relative import and link recomputed from its file's new place _the same resolver script, a new table; path mentions swept by location_
- [x] `test/vitest.config.ts`: `workers` and `node` projects (the Workers config derived from
      apps/os's wrangler base, the long poles, the seeded order); apps/os's config keeps `unit` only
- [x] the shim in packages/iterate; `VITEST_EXTRA_REPORTERS` in core's configs and test.yml
- [x] scripts: root `pnpm test`, apps/os's and test's `test` _root builds apps/os, then `pnpm -r --parallel test`; apps/os `vitest run`, test `--project node --project workers`_
- [x] lint (the platform line has no exception left), knip, tsconfigs, Deploy OS's skip list, CI
      tests, docs and comments
- [x] no file in apps/os or packages/iterate imports `packages/shared/src/test-support` _core's one `packages/shared` import left is the posthog proxy_
- [x] typecheck, lint, knip, format, root `pnpm test`, and CI _locally: apps/os's unit tests (61 files, 1790 tests) and test's node + workers (79 files, 664 + 14 pinned) side by side under Node 24, the same 140 files and 2454 tests as before; the scripts workspace's toolchain and tracing tests fail on macOS bash, as on main_

## Out of scope

- apps/os's other `packages/shared` import, the posthog proxy (the UI work).
- Moving the CI telemetry plumbing out of `packages/shared`.

## Implementation notes

- Option (a) held up: two lines in core's configs, one env var in test.yml, and
  `depot-workflows.test.ts` checks both.
- `sqlfu` and `@cloudflare/workers-oauth-provider` join the catalog (apps/os and test both use
  them); `@cloudflare/vitest-plugin` and `ws` leave apps/os.
- test/'s tsconfig has the Workers and Node types together, so three `URL`s went through a string:
  `generate-wrangler-config.ts` reads the base by `join(import.meta.dirname, …)` (the only change
  to core's code besides comments), the Workers config reads its wrangler overrides the same way,
  and the HMR test dials `url.href`.
- The e2e row-budget scan (`scripts/ci/e2e-policy.test.ts`) skips the in-process `*.test.ts` in
  `test/vitest/os/`: its rules are for e2e rows.
- apps/os no longer reaches `apps/dummy-petshop` (`build.test.ts`'s snapshot), and nothing under
  `apps/` or `packages/` imports apps/os, so the platform-line rule has no exception.
