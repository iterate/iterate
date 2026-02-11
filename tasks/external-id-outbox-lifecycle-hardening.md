---
state: todo
priority: high
size: large
dependsOn: []
tags:
  - machines
  - outbox
  - daytona
  - fly
  - docker
  - reliability
---

# External ID Reliability + Outbox Lifecycle Hardening

Make machine provisioning deterministic so `externalId` is persisted before readiness/activation flow across Daytona/Fly/Docker, and avoid 500s when detached machines point at missing provider resources.

## Why

Current lifecycle creates machine rows with `externalId=""` and populates it later in request-lifetime async provisioning (`waitUntil`).
This can leave stuck rows, readiness races, and bad UX/API behavior (proxy/listAgents 500) when provider resources are missing or replaced.

Observed in prod:

1. machine proxy failures with Daytona `404 Not Found` when preview token fetch targets missing sandbox.
2. detached/starting rows with `externalId=""` and provisioning error metadata.
3. generic 500s from `machine.listAgents` when old machine runner no longer exists.

## Goals

1. Provisioning runs via durable outbox, not request `waitUntil`.
2. `externalId` is persisted before readiness probe enqueue.
3. Provisioning failures move machines to terminal state (`failed`), not indefinite `starting`.
4. `proxy` and `listAgents` return explicit machine-unavailable errors for missing provider resources.
5. Backfill/reconcile existing broken rows.

## Scope

1. `apps/os/backend/services/machine-creation.ts`
2. `apps/os/backend/outbox/consumers.ts`
3. `apps/os/backend/orpc/router.ts`
4. `apps/os/backend/trpc/routers/machine.ts`
5. `apps/os/backend/routes/machine-proxy.ts`
6. `apps/os/backend/integrations/github/github.ts`
7. `apps/os/backend/db/schema.ts` + migration
8. reconciliation script/runbook notes

## Implementation Plan

1. Add `failed` machine state.
2. Add outbox event `machine:provision`.
3. Refactor create flow:
   - insert machine row (`starting`, `externalId=""`)
   - enqueue `machine:provision` tx
   - return immediately
   - remove provisioning `waitUntil` usage in tRPC and GitHub webhook paths
4. Implement provision consumer:
   - skip if machine no longer `starting`
   - create provider resource
   - persist `externalId` + metadata atomically
   - enqueue readiness if daemon already ready/verifying
   - on failure set `state=failed` + provisioning error metadata
5. Tighten `reportStatus` ready handling:
   - if no `externalId`, do not enqueue readiness
   - if `externalId` present, enqueue exactly once
6. Improve API behavior:
   - proxy/listAgents map provider-missing to explicit unavailable error (not generic 500)
   - include actionable message (machine replaced/missing runner)
7. Add reconciliation script:
   - rows with `externalId=""` + provisioningError + non-terminal state -> `failed`
8. Add logs/queries/alerts:
   - count of `externalId=""` by state/type
   - stale `starting`
   - provider-not-found error rate

## API / Type Changes

1. `MachineState` includes `failed`.
2. machine APIs may return `state="failed"`.
3. machine proxy/listAgents return explicit unavailable errors for missing provider resources.

## Tests

1. Unit:
   - create flow enqueues provision event
   - provision success persists `externalId`
   - provision failure sets `failed`
   - reportStatus ready gating on `externalId`
2. Integration:
   - daemon-ready-before-provision race
   - provision-before-daemon-ready race
   - provider missing for detached machine gives explicit unavailable error
3. Regression:
   - active machine rollover still works
   - no duplicate readiness enqueue

## Acceptance Criteria

1. No new `starting` rows with empty `externalId` older than threshold.
2. Provisioning failures consistently become `failed`.
3. Proxy/listAgents missing-provider path no longer returns generic 500.
4. Reconciliation reduces existing empty-`externalId` broken rows to zero active blockers.
