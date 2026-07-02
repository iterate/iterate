# Stream TUI Terminal Specs

These specs use Microsoft TUI Test as the checked-in black-box terminal runner. The runner owns the
PTY. The app still starts through the real user-facing CLI:

```bash
pnpm iterate chat --project prj_... --agent-path /agents/onboarding
```

Run the stable workflow/layout assertions with:

```bash
pnpm --dir apps/os exec tsx ./e2e/tui-test/run.ts
```

For visual review, TUI Test can also record terminal snapshots with colour metadata. Those snapshots
include dynamic stream paths and timestamps, so they are local review artifacts rather than
checked-in regression snapshots for now.

```bash
OS_TUI_SNAPSHOT=1 pnpm --dir apps/os exec tsx ./e2e/tui-test/run.ts -u
```

The TUI runner creates a disposable project for each run and passes its ID to the spec as
`OS_TUI_TEST_PROJECT_ID`.

There is also a headless smoke of the TUI's data layer (shared itx client + shared agent-ui
reducer, no PTY) that drives a full assistant round trip against a disposable project:

```bash
cd apps/os && doppler run -- pnpm exec tsx e2e/tui-test/data-layer-smoke.ts
```
