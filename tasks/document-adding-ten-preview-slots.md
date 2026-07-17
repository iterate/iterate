---
status: in-progress
size: large
branch: docs/add-ten-preview-slots
---

# Document how to add ten preview slots

## Status

Reverse engineering is starting. The deliverable is a tested operator guide for
expanding the preview fleet from nine slots to nineteen; no infrastructure or
secret changes are part of this PR.

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

- [ ] Inventory every checked-in list, loop, type, test, workflow, hostname,
  quota, and integration that assumes slots 1–9 or a nine-slot fleet.
- [ ] Inspect every relevant Doppler project and compare the current preview
  configs, inheritance, and secret-name shapes without reading secret values.
- [ ] Trace resource creation and deployment for each app, including ordering,
  generated Wrangler config, DNS, D1, KV, containers, cleanup, and smoke tests.
- [ ] Trace semaphore leasing, CI slot discovery, assignment, status, reclaim,
  GC, and teardown so slots 10–19 enter the fleet everywhere.
- [ ] Trace per-slot external integrations, especially GitHub and Slack apps,
  and distinguish required setup from optional capability.
- [ ] Find stale or contradictory instructions and verify conclusions against
  executable code and live configuration metadata.
- [ ] Write `docs/adding-preview-slots.md` as a sequenced operator runbook with
  prerequisites, exact edits/commands, checkpoints, rollback or stop
  conditions, and a per-slot completion matrix.
- [ ] Link the new guide from the existing environment documentation and replace
  misleadingly incomplete creation instructions with a clear pointer.
- [ ] Run repository formatting, link/reference checks available locally, and
  focused tests for the scripts whose behavior the guide relies on.
- [ ] Move this task to `tasks/complete/` once the guide and PR are ready.

## Implementation log

- 2026-07-17: Task created in a dedicated worktree from current `origin/main`.
