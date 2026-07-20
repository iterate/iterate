---
status: planning
size: large
branch: ops/create-preview-slots-10-19
started: 2026-07-20
base: af4d2ae48afc3ff66579cf9e5da5e3859c434949
---

# Create preview slots 10–19

## Status

Planning has started from current `main`. No external state has been changed.
The next milestone is a complete, read-only inventory and a concrete approval
request for the exact writes needed to create ten fully capable preview slots.

## Goal

Expand the preview fleet from `preview_1`–`preview_9` to
`preview_1`–`preview_19`, following `docs/adding-preview-slots.md`.

Each new slot must have repository configuration, inherited Doppler configs,
Cloudflare resources, dedicated GitHub and Slack apps, five deployed apps, a
production Semaphore lease, and one proven assign/run/cleanup lifecycle.

## Assumptions and approval boundaries

- The requested batch is exactly `preview_10`–`preview_19`.
- Planning is read-only. Creating configs, cloud resources, integration apps,
  or domains requires approval of the concrete inventory first.
- Any domain purchase requires approval of the exact names, live prices, and a
  maximum total immediately before registration.
- GitHub App creation is limited to the `iterate` organization after approval.
- Slack App creation is limited to the workspace identified in the plan after
  approval.
- Adding production Semaphore leases is a separate approval after every slot
  has been provisioned, deployed, and verified.
- Existing objects are inspected and reconciled. They are never overwritten,
  rotated, renamed, deleted, or replaced without specific approval.
- Credentials go directly from provider responses to Doppler. They must not
  appear in this task, terminal output, chat, screenshots, or git.

## Checklist

- [x] Record the base SHA and create a branch/worktree with this durable ledger.
  _Started `ops/create-preview-slots-10-19` from `af4d2ae48` in the standard
  sibling worktree path._
- [ ] Run read-only Semaphore status and reconciliation from production.
- [ ] Inventory `envs.ts`, operational prose, hidden numeric ranges, and every
  repository edit needed for slots 10–19.
- [ ] Inventory Doppler config names, inheritance, and required secret-name
  presence across `os`, `auth`, `semaphore`, `streams-example-app`, and
  `dummy-petshop` without printing values.
- [ ] Inventory both Cloudflare zones and every slot-named Worker, D1 database,
  KV namespace, R2 bucket, Queue, container app, DNS record, route, and email
  routing object.
- [ ] Recalculate current Cloudflare usage and projected capacity from the
  checked-in container settings and current platform limits.
- [ ] Check `.com` and `.app` domain status and live registration prices for any
  missing domain without purchasing anything.
- [ ] Inventory intended GitHub App names in `iterate` and Slack App names in
  the identified workspace without creating or modifying apps.
- [ ] Write the exact missing-object plan, per-slot stage states, intended
  writes, current prices, price ceiling request, and stop conditions below.
- [ ] Obtain explicit approval for the concrete non-production batch.
- [ ] Add `preview_10`–`preview_19` to `envs.ts` with `UNPROVISIONED` IDs and
  update live operational prose derived from a nine-slot fleet.
- [ ] Create only approved missing Doppler configs and Auth client/runtime
  secrets; verify config inheritance and secret-name shape.
- [ ] Create approved GitHub and Slack apps and pipe credentials directly into
  the matching `os/preview_N` configs.
- [ ] Create Cloudflare resources sequentially, record returned IDs in
  `envs.ts`, and prove idempotence with a clean second ensure pass.
- [ ] Run focused preview/config tests, Auth tests, typecheck, lint, and format
  checks; inspect generated Wrangler config for all ten slots.
- [ ] Push the repository change, open a draft PR early, and keep its external-
  user summary and this ledger current.
- [ ] Merge the repository change before deploying or leasing the slots.
- [ ] Deploy Auth, Dummy Petshop, Semaphore, Streams, and OS sequentially for
  each slot from current `main`; verify integrations and operational telemetry.
- [ ] Present the completed provisioning ledger and obtain separate approval
  to add the production Semaphore leases.
- [ ] Seed leases, require nineteen-slot status and zero reconciliation issues,
  and prove assign/run/cleanup for each slot with a draft canary PR.
- [ ] Move this task to `tasks/complete/` with a date prefix after all ten slots
  pass the normal lifecycle.

## Expansion ledger

`created` is not `verified`. Cells stay unchecked until live state has been
read back from the owning system.

| Slot | Domains | Doppler | Cloudflare + second ensure | GitHub | Slack | Five apps | Lease | Lifecycle |
| ---- | ------- | ------- | -------------------------- | ------ | ----- | --------- | ----- | --------- |
| 10   | ☐       | ☐       | ☐                          | ☐      | ☐     | ☐         | ☐     | ☐         |
| 11   | ☐       | ☐       | ☐                          | ☐      | ☐     | ☐         | ☐     | ☐         |
| 12   | ☐       | ☐       | ☐                          | ☐      | ☐     | ☐         | ☐     | ☐         |
| 13   | ☐       | ☐       | ☐                          | ☐      | ☐     | ☐         | ☐     | ☐         |
| 14   | ☐       | ☐       | ☐                          | ☐      | ☐     | ☐         | ☐     | ☐         |
| 15   | ☐       | ☐       | ☐                          | ☐      | ☐     | ☐         | ☐     | ☐         |
| 16   | ☐       | ☐       | ☐                          | ☐      | ☐     | ☐         | ☐     | ☐         |
| 17   | ☐       | ☐       | ☐                          | ☐      | ☐     | ☐         | ☐     | ☐         |
| 18   | ☐       | ☐       | ☐                          | ☐      | ☐     | ☐         | ☐     | ☐         |
| 19   | ☐       | ☐       | ☐                          | ☐      | ☐     | ☐         | ☐     | ☐         |

## Implementation log

- 2026-07-20: Started from `af4d2ae48` in
  `../worktrees/iterate/create-preview-slots-10-19`. The first pass is limited
  to the runbook's read-only planning phase.
