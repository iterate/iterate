---
name: architect-diagnose-test-flakes
description: Diagnose flaky tests and unstable CI behavior.
---

# Diagnose Test Flakes

Use when tests fail intermittently, retries are needed, or CI is unstable.

## Inputs

- failing test logs/artifacts
- recent git commits/PRs touching the area
- runtime context (timing, shared state, external dependencies)

## Workflow

1. Reproduce flake with targeted repeated runs.
2. Classify source (timing/order/shared-state/external dependency).
3. Isolate minimal deterministic reproduction.
4. Propose smallest reliable fix + guard test.

## Output

- flaky test list + repro command
- root cause category
- concrete fix plan
- risk/rollback notes
