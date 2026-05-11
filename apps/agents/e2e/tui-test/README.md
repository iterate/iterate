# Stream TUI Terminal Specs

These specs use Microsoft TUI Test as the checked-in black-box terminal runner.
The runner owns the PTY. The app still starts through the real user-facing CLI:

```bash
pnpm --dir apps/agents cli stream-tui --project-slug public --stream-path ...
```

Run the stable workflow/layout assertions with:

```bash
pnpm --dir apps/agents test:e2e:tui
```

For visual review, TUI Test can also record terminal snapshots with colour
metadata. Those snapshots include dynamic stream paths and timestamps, so they
are local review artifacts rather than checked-in regression snapshots for now.

```bash
pnpm --dir apps/agents test:e2e:tui:update-snapshots
```

The TUI Test docs call this a terminal screenshot:
<https://github.com/microsoft/tui-test#terminal-screenshot>.
