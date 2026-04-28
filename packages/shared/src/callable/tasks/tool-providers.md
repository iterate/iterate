---
state: planned
priority: medium
size: large
dependsOn: ["rpc.md"]
---

# Tool providers

Tool providers are one motivating use case for Callables, not a new Callable
kind.

A tool provider is a product-level record composed of two Callables:

```ts
type ToolProvider = {
  id: string;
  listTools: Callable;
  callTool: Callable;
};
```

The point is that code mode can store, transmit, and dispatch a tool provider
without knowing whether each half is backed by a public HTTP server, a service
binding, a Durable Object, a Dynamic Worker, or a loopback binding.

Do not add `type: "tool-provider"` to `Callable` unless a later design finds a
real reason. The callable kernel should stay focused: one callable invokes one
thing through Fetch or Workers RPC.

Prefer capability-first APIs where internal providers expose restricted live
stubs/functions. JSON list/call Callables and MCP-style shapes should be edge
adapters, not the only internal model.

Planned scope:

- list tools callable
- call tool callable
- MCP-compatible content arrays and structured content
- pagination
- provider federation and naming collision policy
- how Cap'n Web stubs map to public MCP-compatible tool descriptions
