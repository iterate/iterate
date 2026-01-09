---
state: next
priority: high
size: medium
tags:
  - security
  - proxy
---

# MVP Egress Proxy

Lightweight worker that proxies outbound traffic from sandboxes and substitutes secrets.

For anything that supports HTTPS proxy env vars, see if we can route traffic through a worker that:
- Intercepts outbound requests
- Substitutes secrets/API keys
- Logs/observes traffic

This is the MVP of the broader egress proxy vision (full MITM comes later).
