---
state: todo
priority: high
size: small
dependsOn: []
---

# Quarantine sick preview slots automatically

2026-07-18: preview-7 spent two hours throwing `Durable Object storage
operation exceeded timeout which caused object to be reset` (749×, mostly
CapabilityHostDurableObject, spread over 86 objects including ones born
mid-storm, sticky across deploys, self-recovered untouched) while preview-1
absorbed strictly more load with 10. Verdict: transient Cloudflare
storage-shard degradation — erase-data coverage was audited complete and
accumulation disproven. It cost a full day of PR #2083's merge gate until the
lease was moved by hand. Precedent: preview-6's ~200-error hour on 07-14.

Automate that manual save: before/after each preview run (or in the semaphore
acquire path), count the storage-timeout signature for the slot's worker over
the trailing hour via the Workers Observability query API; above a threshold
(~50/hr), release the lease, mark the slot quarantined in semaphore for a few
hours (they self-heal), and acquire another. Surface quarantines in
`pnpm preview status`.
