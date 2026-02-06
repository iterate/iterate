---
state: todo
priority: medium
tags:
  - infrastructure
  - performance
---

# Improve Realtime Pusher Efficiency

Current realtime pusher broadcasts all updates to all connected clients. Need to scope updates so clients only receive relevant events.

## Problem

- Everyone gets all updates regardless of relevance
- Wasteful bandwidth and processing
- May cause unnecessary re-renders on clients

## Areas to address

- Scope updates by org/project/machine
- Filter subscriptions so clients only receive events they care about
- Consider channel-based routing (e.g., `org:{orgId}`, `machine:{machineId}`)
