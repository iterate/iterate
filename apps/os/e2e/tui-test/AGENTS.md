# Stream TUI Specs

This folder is its own Microsoft TUI Test project root. Run TUI Test from here so `.tui-test/cache`,
`tui-traces`, and snapshot files stay local and the runner does not copy the whole app or monorepo.

Run checked-in workflow specs with:

```bash
pnpm --dir apps/os exec tsx ./e2e/tui-test/run.ts
```

Use Microsoft TUI Test for black-box terminal workflow specs. The runner owns the PTY, but specs must
still launch the real app CLI:

```ts
program: {
  file: "pnpm",
  args: ["-w", "iterate", "chat", "--project", "prj_...", "--agent-path", "/agents/..."],
}
```

Avoid `bash -lc` launchers unless shell behavior is the thing under test.

Prefer positive visible assertions:

```ts
await expect(terminal.getByText("...")).toBeVisible();
```

Use strict locators by default. Use `{ strict: false }` only when text can legitimately appear more
than once, such as stream paths, event names, echoed input, or command labels.

Use `terminal.write()` for partial input, `terminal.submit()` for submitted text or Enter, and key
helpers for navigation. Keep fixed `columns` and `rows` in each `test.use`.

Keep `trace: true`. Treat `.tui-test/cache`, `tui-traces`, and `__snapshots__` as local debug
artifacts.
