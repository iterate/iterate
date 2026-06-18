---
state: planned
priority: medium
size: large
dependsOn: []
---

# Tool providers

Tool providers are one motivating use case for Callables, not a new Callable
kind.

A tool provider is a product-level record composed of one Callable:

```ts
type ToolProvider = {
  id: string;
  callable: Callable;
};
```

The point is that code mode can store, transmit, and dispatch a tool provider
without knowing whether it is backed by a public HTTP server, a service binding,
a Durable Object, a Dynamic Worker, or a loopback binding. Current codemode v1
does not use a reserved `__describe` path. Tool provider registration carries
short instructions, and richer discovery is exposed as ordinary tool functions
such as `listTools`, `listOperations`, or `listProcedures`.

Do not add `type: "tool-provider"` to `Callable` unless a later design finds a
real reason. The callable kernel should stay focused: one callable invokes one
thing through Fetch or Workers RPC.

Prefer capability-first APIs where internal providers expose restricted live
stubs/functions. JSON list/call Callables and MCP-style shapes should be edge
adapters, not the only internal model.

Planned scope:

- provider callable
- MCP-compatible content arrays and structured content
- pagination
- provider federation and naming collision policy
- how Cap'n Web stubs map to public MCP-compatible tool descriptions
