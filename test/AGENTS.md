# Tests outside every app

Every test beyond a simple unit test lives here: tests that stage the platform in-process, run it in the Workers pool, drive a running worker, or drive a browser. None of it goes into the public copy of core/os, and each app keeps only its simple unit tests.

- `vitest/`: the vitest suites, a folder per subject: `os/` and `agents/` (e2e rows against a running worker, and in-process tests), `os-workers/` and `agents-workers/` (the Workers pool); [vitest/AGENTS.md](vitest/AGENTS.md), config `vitest.config.ts`.
- `playwright/`: the browser specs, a folder per app; [playwright/AGENTS.md](playwright/AGENTS.md), config `playwright.config.ts`.
- `helpers/`: what the suites share: the itx client, the deployed target, fakes and fixtures, the Playwright harness.

From the repository root, `pnpm test` runs the in-process and Workers suites (after building core/os), `pnpm e2e` the vitest e2e suite, and `pnpm spec` the specs.
