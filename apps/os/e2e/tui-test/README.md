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

The same command runs in the OS preview CI lane after deploy. The chat and computer-provider
workflows run concurrently, each in its own process and disposable project. A failed workflow gets
one CI retry in another fresh process/project; Microsoft TUI Test's built-in retry stays disabled
because version 0.0.4 reuses a worker it has already terminated on timeout. The bounded outer
watchdog never retries. CI uploads the per-workflow, per-attempt `tui-traces/` tree plus the captured
log with the other preview artifacts.

For visual review, TUI Test can also record terminal snapshots with colour metadata. Those snapshots
include dynamic stream paths and timestamps, so they are local review artifacts rather than
checked-in regression snapshots for now.

```bash
OS_E2E_TUI_SNAPSHOT=1 pnpm --dir apps/os exec tsx ./e2e/tui-test/run.ts -u
```

The TUI runner creates a disposable project with an explicit collision-resistant ID for every
workflow attempt and passes it to that process as `OS_E2E_TUI_PROJECT_ID`.
`ITERATE_FORCE_BUILT_PACKAGE`, `OS_E2E_TUI_ITERATE_BIN`, and `OS_E2E_TUI_TRACE_FOLDER` are internal
wrapper contracts; do not set them for normal development.

There is also a headless smoke of the TUI's data layer (shared itx client + shared agent-ui
reducer, no PTY) that drives a full assistant round trip against a disposable project:

```bash
cd apps/os && doppler run -- pnpm exec tsx e2e/tui-test/data-layer-smoke.ts
```
