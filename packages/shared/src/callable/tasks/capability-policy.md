---
state: planned
priority: high
size: medium
dependsOn: []
---

# Capability policy

V1 validates shape but does not enforce access policy. Treat every Callable as
untrusted code: if a caller passes raw `ctx.env`, the JSON can name any
`env-binding.bindingName` present on that env object. If the caller passes raw
`ctx.exports`, the JSON can name any loopback export exposed there. Before
accepting tenant/user/LLM-authored Callables, add an explicit resolver policy.

Planned scope:

- allowed binding names
- allowed loopback export names
- allowed public URL via values
- allowed RPC methods per binding or via shape
- denied headers
- secret references instead of literal bearer tokens
- callable size limits
- template output limits
- a resolver API that avoids passing raw `env` to untrusted Callables
