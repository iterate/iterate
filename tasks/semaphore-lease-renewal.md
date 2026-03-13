---
state: todo
priority: medium
size: small
---

# Semaphore Lease Renewal

Add explicit lease renewal to `apps/semaphore`.

## Proposed shape

- Add `resources.extend({ type, slug, leaseId, leaseMs })`
- Forward from the main worker to the per-type coordinator DO
- Only renew when the current active lease exists and `leaseId` matches
- Reject renewal if the resource no longer exists in D1
- Return the new `expiresAt`

## Notes

- Renewal should reschedule the next DO alarm when the extended lease becomes the earliest expiry
- Renewal should log an `extended` event in the DO SQLite event table
- Release should remain authoritative; renewal is only for long-lived holders
