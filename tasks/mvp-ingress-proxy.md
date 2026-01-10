---
state: next
priority: high
size: medium
tags:
  - security
  - proxy
---

# MVP Ingress Proxy

Authenticated proxy for inbound traffic to sandboxes.

## Initial approach

Use the data structure in iterate config to decide what the ingress proxy does (routing rules, auth, etc).

## Future

Write custom code for routing logic, using either:

- Dynamic worker loading
- Cloudflare Workers for Platforms

But that's further out than MVP.
