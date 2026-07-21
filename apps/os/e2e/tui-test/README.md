# Stream TUI Terminal Specs

These specs use Microsoft TUI Test as the checked-in black-box terminal runner. The runner owns the
PTY. The wrapper first builds `packages/iterate`, then forces the real user-facing bin to load that
dist artifact rather than the monorepo TypeScript source:

```bash
pnpm iterate chat --project prj_... --agent-path /agents/onboarding
```

Run the stable workflow/layout assertions with:

```bash
pnpm --dir apps/os exec tsx ./e2e/tui-test/run.ts
```

The same command runs in the OS preview CI lane after deploy. It gets one test-level retry in CI,
a bounded outer watchdog that never retries, and uploads `tui-traces/` plus its captured log with
the other preview artifacts.

For visual review, TUI Test can also record terminal snapshots with colour metadata. Those snapshots
include dynamic stream paths and timestamps, so they are local review artifacts rather than
checked-in regression snapshots for now.

```bash
OS_E2E_TUI_SNAPSHOT=1 pnpm --dir apps/os exec tsx ./e2e/tui-test/run.ts -u
```

The TUI runner creates a disposable project with an explicit collision-resistant ID for each run
and passes it to the spec as `OS_E2E_TUI_PROJECT_ID`. `ITERATE_FORCE_BUILT_PACKAGE` is an internal
wrapper-to-bin contract; do not set it for normal development.

There is also a headless smoke of the TUI's data layer (shared itx client + shared agent-ui
reducer, no PTY) that drives a full assistant round trip against a disposable project:

```bash
cd apps/os && doppler run -- pnpm exec tsx e2e/tui-test/data-layer-smoke.ts
```
