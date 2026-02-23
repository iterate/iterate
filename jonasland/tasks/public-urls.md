---
state: todo
priority: high
size: l
dependsOn: [project-deployment-abstraction.md]
---

Provide public routable hostnames for local and hosted usage.

MVP notes:

- machine provider creates ingress URL
- wildcard domain terminates at OS worker
- OS worker forwards to machine public URL
- Caddy enforces route-level access control
