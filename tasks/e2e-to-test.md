---
status: in-progress
size: large
---

# The vitest suites that hit a running worker move to `test/`

Pre-work for moving apps/os into `core/`, PR 1 of 3 from the e2e plan. The 09/29 call agreed that
the public copy of core gets no tests pointed at a running server, and that those live in a
top-level `test/`, never copied, with a folder per runner (`playwright/`, `vitest/`) and
`helpers/` beside them. Settled with Misha after the call: the folder is `test/`, it is its own
workspace package (`@iterate-com/test`), `__workers-tests__` stays in core, and this PR goes first
(then the Playwright specs, then packages/shared's test helpers).

Status: not started.

## Moves

| From                                                                                           | To                                                                                                                                                   |
| ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/os/e2e/*.e2e.test.ts`                                                                    | `test/vitest/os/`                                                                                                                                    |
| `apps/os/e2e/support/**`                                                                       | `test/helpers/**`                                                                                                                                    |
| `apps/os/e2e/support/{config-worker,scheduled-append-facet,fake-artifacts,fake-git-server}.ts` | `apps/os/test-support/`: core's own tests use them (11 `__workers-tests__` files, `src/repo/durable-object.test.ts`), and core never imports outside |
| `apps/os/perf/**`, `apps/os/bench/**`                                                          | `test/vitest/os/perf/**`, `test/vitest/os/bench/**`                                                                                                  |
| `apps/agents/e2e/**`                                                                           | `test/vitest/agents/**`                                                                                                                              |
| `apps/os/e2e/AGENTS.md`                                                                        | `test/AGENTS.md`                                                                                                                                     |

## Checklist

- [ ] the moves, every relative import recomputed from its file's new place
- [ ] `test/package.json` (`@iterate-com/test`: `e2e`, `e2e:run`, `perf`, `perf:run`, `bench`,
      `test` for the helpers' own tests, `typecheck`), `test/tsconfig.json`, and `test` in
      `pnpm-workspace.yaml`
- [ ] `test/vitest.config.ts`: the `e2e`, `perf` and `bench` projects and the root options they
      rely on (the long poles, the reporters, `onUnhandledError`, a global setup running apps/os's
      `scripts/build.ts`); apps/os's config keeps `unit` and `workers`
- [ ] apps/os: scripts, `tsconfig.tests.json`, `LONG_POLES`, knip entries; no `envs.ts` import
      left (`build.test.ts`'s snapshot)
- [ ] CI and scripts run the suites from `test/`: `scripts/os/preview.ts`, `e2e-soak.ts`,
      `slow-rows.ts`, `scripts/monitors/latency.ts`, the crash-hunt, soak, latency and
      real-model workflows, `depot-workflows.test.ts`; the preview's path filter watches `test/**`
- [ ] lint: the platform-line rule drops its `e2e/support` exception once nothing under
      `apps/` or `packages/` imports it; `rules/` globs and oxlint/oxfmt lists name the new paths
- [ ] docs and comments name the new paths
- [ ] lint, format, knip, typecheck, apps/os's `pnpm test`, the helpers' tests, a local
      `pnpm --dir test e2e` over a few files, and CI's Preview OS E2E tests against the preview

## Out of scope

- `specs/` → `test/playwright/` (PR 2), `packages/shared/src/test-support` → `test/helpers/`
  and a `failing-test` copy in apps/os (PR 3).
- `__workers-tests__`' reach outside core (its `support.ts` imports apps/dummy-petshop, and
  apps/os's `workers` project runs `apps/agents/__workers-tests__`).
- `fake-git-server.ts` importing `@iterate-com/shared/test-support/fetch-safe-port`: PR 3.

## Implementation notes
