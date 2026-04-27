---
state: planned
priority: high
size: medium
dependsOn: []
---

# Capability policy

V1 validates shape but does not enforce access policy. Treat every Callable as
untrusted code: if a caller passes raw `ctx.env`, the JSON can name any binding
present on that env object. Before accepting tenant/user/LLM-authored Callables,
add an explicit resolver policy.

Planned scope:

- allowed binding names
- allowed HTTP upstream origins
- denied headers
- secret references instead of literal bearer tokens
- descriptor size limits
- template output limits
- a resolver API that avoids passing raw `env` to untrusted descriptors
