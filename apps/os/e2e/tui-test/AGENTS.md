# Retired TUI checks

The CLI TUI was removed when the CLI moved to OS Next. `run.ts` only reports a
skip for the legacy OS preview orchestrator. CLI coverage lives in
`packages/iterate/src/cli.test.ts` and `apps/os-next/e2e/iterate-cli.e2e.test.ts`.
