# Tests against a running system

Everything here drives a running worker or a browser, so none of it goes into the public copy of apps/os. Each app keeps its own in-process tests.

- `vitest/`: the vitest suites against a running worker, a folder per subject (`os/`, `agents/`); [vitest/AGENTS.md](vitest/AGENTS.md), config `vitest.config.ts`.
- `playwright/`: the browser specs, a folder per app; [playwright/AGENTS.md](playwright/AGENTS.md), config `playwright.config.ts`.
- `helpers/`: what the suites share: the itx client, the deployed target, the Playwright harness.

From the repository root, `pnpm e2e` runs the vitest e2e suite and `pnpm spec` the specs.
