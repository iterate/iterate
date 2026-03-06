---
state: backlog
priority: medium
size: small
tags:
  - lint
  - a11y
dependsOn: []
---

# Re-enable route-level a11y lint rules

## Context

During migration from ESLint to Oxlint we disabled a subset of `jsx-a11y` rules for:

- `apps/os/app/routes/**/*.ts(x)`
- `apps/daemon/client/routes/**/*.ts(x)`

Rules disabled in config:

- `jsx-a11y/no-autofocus`
- `jsx-a11y/label-has-associated-control`
- `jsx-a11y/click-events-have-key-events`
- `jsx-a11y/no-static-element-interactions` (daemon routes)

## Goal

Fix current violations in those route folders and remove these temporary config exceptions.
