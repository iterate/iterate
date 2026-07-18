---
state: todo
priority: low
size: small
dependsOn: [eager-worker-build-on-commit.md]
---

# buildBudgetMs for the delivery lane

The fetch lane resolves workers under a buildBudgetMs race (stale-while-build,
building page); the delivery lane blocks its frame on the full cold build for
commit-then-delivery-sees-new-code. With eager-on-commit builds in place,
consider giving delivery a bounded budget too: past it, throw the retryable
in-progress error and let at-least-once delivery retry into the cache instead
of holding stream delivery frames for the slowest build. Follow-up listed on
PR #2083; keep the no-HOL-blocking principle in view.
