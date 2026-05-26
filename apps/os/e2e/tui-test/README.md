# Stream TUI Terminal Specs

These specs use Microsoft TUI Test as the checked-in black-box terminal runner. The runner owns the
PTY. The app still starts through the real user-facing CLI:

```bash
pnpm --dir apps/os cli stream-tui --project-slug-or-id public --stream-path ...
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
`OS_TUI_TEST_PROJECT_SLUG_OR_ID`.
