# Stream TUI specs

This suite is quarantined. `run.ts` is an explicit no-op skip, not passing coverage. Read [the restoration task](../../../../tasks/quarantined-tui-e2e.md) before reviving it.

Keep the real installed CLI as the program under test. This directory is the TUI Test project root so caches, PTY traces and snapshots stay local. Avoid shell launchers unless shell behavior is under test.

Use visible assertions, strict locators unless duplicate text is legitimate, fixed terminal dimensions, and `trace: true`. `terminal.write()` sends partial input; `terminal.submit()` sends submitted text or Enter. Keep generated caches/traces/snapshots out of Git.
