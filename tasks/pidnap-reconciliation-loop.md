---
state: todo
priority: high
size: large
dependsOn: []
---

# Refactor pidnap to reconciliation loop

## Goal

Refactor pidnap process control to a reconciliation model:

- input: desired process state
- observed: current runtime/process state
- output: deterministic action list
- execution: apply actions, then re-observe

## Design direction

- Define desired model from config + API mutations (single source of truth).
- Define observed model from live process table + runtime metadata.
- Add pure planner that computes actions (`start`, `stop`, `restart`, `create`, `delete`, `noop`).
- Add executor that applies actions with ordering and retry rules.
- Run reconcile loop on triggers:
  - manager start
  - desired-state mutation
  - process exit/state change
  - env reload trigger

## Acceptance criteria

- Reconcile is idempotent: repeated runs with no drift produce no actions.
- Action plans are deterministic for the same desired/observed inputs.
- Startup and mutation paths route through planner/executor (no separate imperative branches).
- Structured logs include reconciliation iteration id and planned/applied actions.
- Regression coverage for add/update/delete/restart scenarios.
