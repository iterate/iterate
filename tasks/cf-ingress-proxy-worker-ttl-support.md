---
state: todo
priority: medium
size: small
dependsOn: []
---

# Add TTL support to cf-ingress-proxy-worker routes

Deferred follow-up:

- add optional TTL fields in route pattern schema/API
- enforce expiry in resolver path
- decide lazy-expire vs active cleanup behavior
- add coverage (unit + real deployment E2E)
