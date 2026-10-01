---
status: ready
size: small
---

# Scripts let trpc-cli name themselves

**Status:** spec only; implementation follows in the next commit.

Every trpc-cli script ends with `createCli({ ...import.meta, name: "<its own basename>" })`, because `docs/typescript-conventions.md` prescribes `name: "<name>"`. Cursor Bugbot flagged it as redundant on iterate/iterate#3495 (`scripts/ci/shadcn-registry.ts:355`).

trpc-cli 0.17.0 names a program itself ("How the CLI name is resolved" in its readme). For our scripts:

- `node scripts/os/deploy.ts`: the entry script's basename, `deploy`. Same as the explicit name.
- `pnpm os:deploy` (root package scripts): the npm script name, `os:deploy`. Explicit `name` gives `deploy`.
- No `bin` entries point at scripts, so the bin rule never applies.

Decision: drop `name` wherever it equals the basename, and leave trpc-cli's priority alone. Under `pnpm`, `os:deploy` is the better name: it is what you type after `pnpm`, while `Usage: deploy` at the repo root points at pnpm's built-in `pnpm deploy`. A monorepo switch in trpc-cli would key off the wrong thing.

- [ ] `scripts/**`: `createCli({ ...import.meta, name: "<basename>" })` → `createCli(import.meta)`
- [ ] `apps/*/scripts/**` and `core/os/scripts/getin.ts`: same, since the convention doc covers them
- [ ] keep `name` where the basename says too little: `scripts/ci/tracing/cli.ts` (`ci-trace`), `scripts/ci/flake-dashboard/update.ts` (`flake-dashboard-update`)
- [ ] `docs/typescript-conventions.md`: prescribe `createCli(import.meta)`, say when `name` earns its place
- [ ] `docs/depot-ci.md`: same form
- [ ] verify `--help` usage lines under `node` and `pnpm <script>` before and after
