---
state: todo
priority: medium
size: small
tags:
  - sandbox
  - ingress-proxy
---

# Add secret auth to project ingress proxy

Follow-up after phase one of `apps/project-ingress-proxy`:

- Require `PROJECT_INGRESS_PROXY_SECRET` env var.
- Validate inbound `X-Iterate-Project-Ingress-Secret` against env var.
- Return `401` on mismatch or missing secret header.
- Strip `X-Iterate-Project-Ingress-Secret` before forwarding upstream.
- Add/adjust unit + integration tests for auth success/failure paths.
