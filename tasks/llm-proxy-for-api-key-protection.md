---
state: todo
priority: high
size: medium
tags:
  - security
  - proxy
  - harness
---

# LLM Proxy for API Key Protection

Protect LLM API keys in sandboxes by routing requests through a proxy. Sandboxes should never have direct access to API keys.

Per-harness task: need to figure out how to tell each harness what base URL to use for LLM requests.

Ideally use OpenRouter or similar unified endpoint.
