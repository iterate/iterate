---
status: complete
size: large
branch: docs/add-ten-preview-slots
---

# Document how to add ten preview slots

## Status

Complete. The new runbook covers repository edits, Doppler inheritance,
Cloudflare provisioning, external apps, deployment, leasing, and per-slot
acceptance. It records the live drift found during the audit. No infrastructure
or secret state changed in this PR.

## Goal

Write one readable document that tells an operator exactly how to add
`preview_10` through `preview_19`. It must describe the real system rather than
repeat the current four-line bring-up summary.

The guide should make it hard to create a slot that deploys but is absent from
leasing, uses the wrong Doppler inheritance, lacks an integration-specific app,
or cannot be cleaned up safely.

## Assumptions

- This PR documents the expansion; it does not provision Cloudflare resources,
  create Doppler configs, or create GitHub and Slack apps.
- The intended target is ten complete slots with the same capabilities as the
  current fleet, not ten OS-only workers.
- Existing live configuration may disagree with checked-in docs or code. The
  guide will call those disagreements out instead of silently choosing one.
- Secret values must never be copied into the task, document, terminal output,
  commits, or PR. Names, config relationships, and presence/absence are enough.

## Checklist

- [x] Inventory every checked-in list, loop, type, test, workflow, hostname,
  quota, and integration that assumes slots 1–9 or a nine-slot fleet. _Found
  five environment maps, the lease inventory, four Auth audience lists, two
  client/preset lists, and stale operational prose._
- [x] Inspect every relevant Doppler project and compare the current preview
  configs, inheritance, and secret-name shapes without reading secret values.
  _Audited all six relevant projects, their branch inheritance, and secret-name
  shapes; no secret values were printed or recorded._
- [x] Trace resource creation and deployment for each app, including ordering,
  generated Wrangler config, DNS, D1, KV, containers, cleanup, and smoke tests.
  _The runbook now separates ensure, ID recording, ordered first deployment,
  second-pass verification, and the Streams DNS exception._
- [x] Trace semaphore leasing, CI slot discovery, assignment, status, reclaim,
  GC, and teardown so slots 10–19 enter the fleet everywhere. _Documented the
  source-driven inventory, destructive stale-checkout hazard, and canary lease
  lifecycle._
- [x] Trace per-slot external integrations, especially GitHub and Slack apps,
  and distinguish required setup from optional capability. _Verified the live
  config topology and documented real-app validation beyond optional config and
  stand-in e2e coverage._
- [x] Find stale or contradictory instructions and verify conclusions against
  executable code and live configuration metadata. _Recorded the GitHub
  hostname/key/script defects, shared preview-1 App, invalid Slack tokens,
  Dummy Petshop comment drift, and missing Streams dependency._
- [x] Write `docs/adding-preview-slots.md` as a sequenced operator runbook with
  prerequisites, exact edits/commands, checkpoints, rollback or stop
  conditions, and a per-slot completion matrix. _Added the eight-stage runbook
  and ten-row operator record._
- [x] Link the new guide from the existing environment documentation and replace
  misleadingly incomplete creation instructions with a clear pointer. _Linked
  both environment entry points to the complete expansion guide._
- [x] Run repository formatting, link/reference checks available locally, and
  focused tests for the scripts whose behavior the guide relies on. _Formatting
  and local links pass; preview config/inventory tests pass 128/128 and Auth
  tests pass 33/33._
- [x] Move this task to `tasks/complete/` once the guide and PR are ready. _Moved
  on 2026-07-17 after the documentation and focused verification were complete._

## Implementation log

- 2026-07-17: Task created in a dedicated worktree from current `origin/main`.
- 2026-07-17: Audited repository assumptions, live Doppler metadata, Cloudflare
  resource inventory and limits, Semaphore reconciliation, and GitHub/Slack
  credential behavior without mutating external state.
- 2026-07-17: Added and cross-linked the runbook, including capacity math,
  first-deploy ordering, stop conditions, drift notes, and a completion ledger.
- 2026-07-17: Review replaced the duplicated expansion lists with one `envs.ts`
  source-of-truth design and distinguished one tautological inventory assertion
  from the preview test file's behavioral state-machine coverage.
