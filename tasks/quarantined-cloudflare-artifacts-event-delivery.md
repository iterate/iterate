---
state: todo
priority: high
size: medium
tags: [ci, e2e, repositories, cloudflare, quarantine]
---

# Restore scalable Cloudflare Artifacts event delivery

Cloudflare Artifacts push-event delivery was quarantined on 2026-07-21 while
landing PR #2169. The removed implementation created one account-level event
subscription per repository and synchronously reconciled it before a
repository's first push. Consequently, every project bootstrap crossed the
shared Cloudflare account control plane before it could become ready.

## Evidence

- Concurrent, independently named projects all called the same account-level
  queue and event-subscription REST APIs during repository creation.
- Preview runs across unrelated PRs saw those APIs return account-wide `429`
  responses with `Retry-After: 120` and Cloudflare `500` / code `15000`
  responses while unrelated data-plane operations remained healthy.
- One preview rerun then timed out across many independently provisioned
  projects at once. Project IDs isolated Durable Object state, but could not
  isolate this shared control-plane dependency.
- The bridge also made deploy and `ensure-resources` enumerate/reconcile
  account-level queues, repositories, and subscriptions.

## Quarantined behavior

- Cloudflare Artifacts pushes are not consumed from an OS Worker queue.
- Normal and externally initiated pushes therefore do not automatically emit
  `repo/cloudflare-artifact-event-received`, `repo/commit-completed`, or
  `repo/task-*` stream facts. Repository contents, direct reads/writes,
  builds, and project readiness remain active.
- The live e2e contract is explicitly skipped in
  `apps/os/e2e/vitest/artifact-event-delivery.e2e.test.ts`.

## Work

- Define a delivery interface independent of Cloudflare's subscription and
  queue products.
- The next OS deploy for each environment detaches only that Worker's retained
  legacy Queue consumer. Cloudflare otherwise rejects the first handler-less
  upload. This idempotent rollout guard is a read-only no-op after migration;
  remove it when every environment has crossed the boundary.
- After every deployment has shipped without the consumer, perform a one-off
  audited deletion of the retired subscriptions and queues; verify there is no
  producer traffic or retained-message backlog. Do not put subscription/queue
  enumeration or cleanup back into project creation or steady-state deploys.
- Emit commit facts directly for OS-owned writes and imports so they do not
  depend on eventual account-level events.
- Choose a bounded, deployment-global mechanism for genuinely external
  Artifact pushes. It must not perform per-project control-plane
  reconciliation and must expose queueing, saturation, and failure telemetry.
- Decide whether external Artifact pushes are a supported product surface at
  all; if not, delete the dormant event contract and processor branches.

## Exit criteria

- Creating many projects concurrently performs zero Cloudflare account-level
  queue or event-subscription API calls.
- The replacement has a live e2e proving internal and supported external push
  semantics, including commit/task facts and duplicate delivery.
- A retry-disabled preview marathon shows no project-create tail correlated
  across otherwise independent projects and no unexplained control-plane
  errors.
- Remove the explicit skip and the warning in `docs/testing.md` only with that
  evidence.
