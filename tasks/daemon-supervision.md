---
state: next
priority: high
size: medium
tags:
  - sandbox
  - infrastructure
---

# Daemon Supervision

The entry point for daemons running in sandboxes should be a supervisor/bootstrapper, so the daemon runs under supervision (e.g., s6).
