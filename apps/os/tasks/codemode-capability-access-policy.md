---
state: todo
priority: medium
size: medium
dependsOn:
  - codemode-session-vertical-slice.md
---

# Codemode Capability Access Policy

Define how a `CodemodeSessionCapability` can be scoped before it is passed to a
Dynamic Worker or Tool Provider.

For now the vertical slice intentionally has no policy layer. The session
capability is narrow, but it can still append events, start scripts, and call
registered Tool Functions. Before this becomes product behavior, decide:

- which codemode control functions can be exposed to a given caller
- whether Tool Function paths need allow/deny lists
- how cancellation and long-running calls interact with policy
- how policy decisions are represented in events
- where provider-supplied bridges declare requested permissions
