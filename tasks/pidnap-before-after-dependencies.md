---
state: todo
priority: high
size: medium
dependsOn:
  - pidnap-reconciliation-loop
---

# Replace dependsOn with before/after ordering model

## Goal

Replace `dependsOn` in pidnap process definitions with explicit ordering edges:

- `before: ["other-process"]`
- `after: ["other-process"]`

## Scope

- Update config schema and dependency graph builder.
- Preserve existing semantics for startup gating and dependency-triggered starts.
- Provide compatibility path from existing `dependsOn` configs.

## Migration plan

1. Add `before` / `after` schema support.
2. Normalize config into one internal edge model.
3. Keep `dependsOn` read support temporarily with deprecation warning.
4. Update docs/examples to `before` / `after`.
5. Remove `dependsOn` after migration window.

## Acceptance criteria

- Existing `dependsOn` configs still run during transition.
- New `before` / `after` configs produce correct start order and cycle detection.
- Clear validation errors for conflicting/cyclic edge definitions.
- Tests cover mixed-mode configs and normalized graph output.
