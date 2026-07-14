---
state: backlog
priority: medium
size: small
---

# Fix Node's built-in WebSocket close event through container intercept

PR #1932 proves duplex frames for Node's built-in client, full close semantics
for `ws@8.21.0`, and a stock Codex turn. The built-in client alone misses the
fixture's reciprocal close event after its own `1000` close.

Done when the built-in client receives the exact close code and reason through
container intercept in `sandbox-egress.e2e.test.ts`.
