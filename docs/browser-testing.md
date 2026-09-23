# Browser testing

Use an isolated Playwriter browser session for each task. Read the personal Playwriter skill before using the CLI. Jonas's personal Chrome requires explicit authorization.

The automated platform browser suite is `pnpm spec`, configured in [apps/os/playwright.config.ts](../apps/os/playwright.config.ts). It starts a local Worker by default. Set `DEMO_BASE_URL` and the target's test credentials to run against an existing deployment.

Use a disposable project and verify the resulting state. Do not reuse production identities or shared test state merely to bypass authentication setup.
