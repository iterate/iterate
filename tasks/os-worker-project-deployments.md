---
state: todo
priority: high
size: large
dependsOn:
  - project-ingress-proxy-improvements
---

# Replace OS worker machine model with project deployment model

## Context

Today OS worker ingress and command paths are machine-first (`machineId`, machine state, machine port routing).

Direction: OS worker should become deployment-first.

A project deployment is the primitive:

- routable HTTP target
- start/stop lifecycle
- health-checkable over HTTP
- interactive control surface over HTTP (exec/commands, status, diagnostics)

## Problem

Machine-centric contracts leak infrastructure details into APIs and hostname resolution logic.

This makes ingress/auth/lifecycle code harder to reason about and blocks cleaner deployment abstractions.

## Goal

Introduce a clear `ProjectDeployment` interface and migrate OS worker logic to use it as the primary unit.

Machines become implementation detail behind deployment runtime adapters.

## Proposed interface shape

`ProjectDeployment` (conceptual):

- identity: `deploymentId`, `projectId`, `runtimeType`
- traffic: `getFetcher()` / `routeHttp(request)`
- lifecycle: `start()`, `stop()`, `restart()`
- health: `checkHealth()` + state transitions
- control: `exec(command)` / optional command sessions
- observability hooks: deployment-scoped status + traces + logs

## Migration plan

1. Add deployment domain model + DB/API shape (parallel to machine fields).
2. Create runtime adapters:
   - machine-backed deployment adapter (initial)
   - future non-machine runtimes
3. Move ingress hostname resolution to deployment targets instead of machine ids.
4. Move machine proxy / project ingress code paths to deployment fetcher API.
5. Keep compatibility layer so existing machine URLs continue to resolve during transition.
6. Deprecate machine-first worker routes + contracts after rollout.

## Acceptance criteria

- OS worker ingress path resolves to `ProjectDeployment` (not raw machine lookups).
- Start/stop/health/exec operations are expressed in deployment API.
- Existing machine-based links continue to work via compatibility mapping.
- Monitoring/logging surfaces are deployment-scoped.
- Developer-facing interfaces describe deployments, not machines.

## Open questions

- Deployment ID format and stable hostname model.
- How to model multi-service deployments (one deployment, many ports/services).
- Migration strategy for existing `mach_*` references in client UI and APIs.
- Auth model for deployment endpoints (session vs signed service tokens).
