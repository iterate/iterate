---
status: ready
size: small
---

# Scripts let trpc-cli name themselves

**Status:** done. 28 scripts call `createCli(import.meta)`; two keep `name`; both docs updated. Nothing missing.

Every trpc-cli script ends with `createCli({ ...import.meta, name: "<its own basename>" })`, because `docs/typescript-conventions.md` prescribes `name: "<name>"`. Cursor Bugbot flagged it as redundant on iterate/iterate#3495 (`scripts/ci/shadcn-registry.ts:355`).

trpc-cli 0.17.0 names a program itself ("How the CLI name is resolved" in its readme). For our scripts:

- `node scripts/os/deploy.ts`: the entry script's basename, `deploy`. Same as the explicit name.
- `pnpm os:deploy` (root package scripts): the npm script name, `os:deploy`. Explicit `name` gives `deploy`.
- No `bin` entries point at scripts, so the bin rule never applies.

Decision: drop `name` wherever it equals the basename, and leave trpc-cli's priority alone. Under `pnpm`, `os:deploy` is the better name: it is what you type after `pnpm`, while `Usage: deploy` at the repo root points at pnpm's built-in `pnpm deploy`. A monorepo switch in trpc-cli would key off the wrong thing.

- [x] `scripts/**`: `createCli({ ...import.meta, name: "<basename>" })` → `createCli(import.meta)` _21 files, including `scripts/ci/shadcn-registry.ts` from #3495_
- [x] `apps/*/scripts/**` and `core/os/scripts/getin.ts`: same, since the convention doc covers them _7 files_
- [x] keep `name` where the basename says too little: `scripts/ci/tracing/cli.ts` (`ci-trace`), `scripts/ci/flake-dashboard/update.ts` (`flake-dashboard-update`) _untouched_
- [x] `docs/typescript-conventions.md`: prescribe `createCli(import.meta)`, say when `name` earns its place _"Scripts are trpc-cli programs" section_
- [x] `docs/depot-ci.md`: same form _"Editing Workflows"_
- [x] verify `--help` usage lines under `node` and `pnpm <script>` before and after _see implementation notes_

## Implementation notes

`--help` usage line, before → after:

| Invocation                             | Before                 | After                        |
| -------------------------------------- | ---------------------- | ---------------------------- |
| `node scripts/ci/shadcn-drift.ts`      | `shadcn-drift`         | `shadcn-drift`               |
| `node scripts/os/deploy.ts`            | `deploy`               | `deploy`                     |
| `pnpm preview`, `pnpm getin`           | same                   | same                         |
| `pnpm os:deploy`, `pnpm os:erase-data` | `deploy`, `erase-data` | `os:deploy`, `os:erase-data` |

Typecheck passes in scripts, apps/agents, apps/ci-reports, apps/dummy-petshop, apps/kit, apps/spa, core/os. oxfmt, oxlint and knip are clean (run from a worktree outside `.claude/`, where lint silently skips files). `pnpm --dir scripts test`: 7 failures in `ci/toolchain.test.ts` and `ci/tracing/tracing.test.ts`, identical on clean main on this Mac.
