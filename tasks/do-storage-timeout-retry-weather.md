---
state: todo
priority: medium
size: small
dependsOn: []
---

# Classify DO storage-timeout resets as retry-weather

`Durable Object storage operation exceeded timeout which caused object to be
reset.` is Cloudflare's storage-layer failure, not application poison — but
today it surfaces as generic errors that pin callers to their full timeouts
(observed 2026-07-18: uniform ~160s spec stalls, wakes parked until
watchdogs). Tag it into the existing retryable backoff lane the way
stream-unavailable and receiver-unavailable are (prior art:
apps/os/src/rpc-targets.ts stream-unavailable tagging, PR #1825
poison-skip classification) so wakes and waiters fail fast and retry instead
of dwelling on a sick object. Partial mitigation by design — the object stays
on its degraded shard — pairs with the slot quarantine task.
