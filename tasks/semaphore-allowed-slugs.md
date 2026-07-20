---
status: ready
size: medium
---

# Restrict Semaphore acquisition to allowed slugs

Status: Specified; implementation has not started. This prerequisite must land and deploy before preview slots 10–19 enter production inventory.

## Goal

Let callers constrain generic Semaphore acquisition to an explicit set of resource slugs, while keeping older preview clients safely limited to the original nine slots during the rollout.

## Decisions and assumptions

- Add optional `allowedSlugs` to both `acquire` and `acquireSpecific`; filtering happens atomically inside the Resource Coordinator.
- Omitted `allowedSlugs` preserves generic behavior for every resource type except `environment-config-lease`.
- For `environment-config-lease`, omission temporarily defaults to `preview-1` through `preview-9`, so older clients cannot acquire newly seeded slots.
- A supplied list must be non-empty and contain unique, valid slugs.
- Waiting, least-recently-used selection, lease renewal, and force semantics operate only within the allowed set.
- This PR does not seed inventory or deploy preview applications.

## Checklist

- [ ] Specify the public acquisition behavior with failing integration-style tests.
- [ ] Add `allowedSlugs` to the public contract and Resource Coordinator inputs.
- [ ] Filter generic and specific acquisition atomically.
- [ ] Preserve the legacy-safe preview fallback for omitted input.
- [ ] Verify focused tests, typecheck, lint, and formatting.
- [ ] Deploy Semaphore production before any client requires the new input.

## Implementation log

- 2026-07-20: Split from preview-slot expansion so the server can accept the new field before PR #2161 starts sending it.
