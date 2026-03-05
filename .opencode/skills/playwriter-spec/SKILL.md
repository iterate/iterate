---
name: playwriter-spec
description: Run a Playwright spec manually in the browser via Playwriter, mirroring test steps while debugging and adapting in-flight.
publish: true
---

# Manual Spec via Playwriter

Use this when a spec is flaky/in-flux and you want to execute the same flow manually with live debugging.

## Workflow

1. Read the target spec fully.
2. Extract exact user journey, data setup, and assertions.
3. Reproduce steps in Playwriter (observe -> act -> observe after each major action).
4. If behavior diverges, debug in-place (logs, status UI, infra logs) and continue.
5. Record concrete timings, blockers, and recovery actions.
6. If asked, patch the spec/product to match the observed reliable behavior.

## Rules

- Stay faithful to spec intent; only deviate when needed to unblock and explain why.
- Prefer product signals over sleeps (state text, loading indicators, toasts, status badges).
- For long async phases, rely on spinner-based waits + polling UIs instead of giant raw waitFor timeouts.
- Summarize outcomes as: pass/fail, evidence, and concrete fixes.
