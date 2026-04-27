---
state: planned
priority: medium
size: large
dependsOn: ["rpc.md"]
---

# Tool providers

Add a transport-agnostic tool provider shape after fetch and RPC are stable.
Prefer capability-first APIs where internal providers expose restricted live
stubs/functions. JSON list/call descriptors and MCP-style shapes should be edge
adapters, not the only internal model.

Planned scope:

- list tools callable
- call tool callable
- MCP-compatible content arrays and structured content
- pagination
- provider federation and naming collision policy
- how Cap'n Web stubs map to public MCP-compatible tool descriptors
