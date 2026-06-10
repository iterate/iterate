---
name: playwriter-spec
description: Run a Playwright e2e test manually in the browser via Playwriter while debugging and adapting in-flight.
publish: true
---

# Manual E2E via Playwriter

Use when an app e2e test is flaky or in flux and you want to execute the same flow manually with live debugging.

Tests live under each app, e.g. `apps/os/e2e/`, not a root `spec/` directory.

## Workflow

1. Read the target test file fully.
2. Extract user journey, setup, and assertions.
3. Reproduce steps in Playwriter (observe → act → observe).
4. Debug in-place if behavior diverges.
5. Record timings, blockers, and recovery actions.
6. If asked, patch the test or product to match reliable behavior.

## Rules

- Stay faithful to test intent; explain deviations.
- Prefer product signals over sleeps (loading UI, toasts, status text).
- Summarize: pass/fail, evidence, concrete fixes.

## Running tests

```bash
APP_CONFIG_BASE_URL=https://… pnpm --dir apps/os e2e
```

See each app's `package.json` for required env vars.
