---
state: todo
priority: medium
size: medium
dependsOn: []
---

# OS Project Route Authorization

## Context

Project ingress can route to many project-local destinations. MCP is only the
first obvious destination; future destinations may include websites, events,
admin tools, generated apps, or runtime-loaded fetch callables.

The Project Durable Object should not grow destination-specific authorization
methods such as `authorizeMcpServerConnection(...)`. That would couple the
Project lifecycle authority to each app/protocol one at a time.

## Goal

Design a generic Project Route Authorization model owned by the Project Durable
Object.

## Scope

- Define how a Project Route Destination declares auth requirements.
- Define the principal shape passed to authorization checks.
- Decide how protocol entrypoints, such as `ProjectMcpServerEntrypoint`, pass
  verified identity into the generic authorization model.
- Decide where route-specific scopes live and how they relate to Clerk OAuth
  scopes.
- Add a generic Project Durable Object method for evaluating access to a Project
  Route Destination if needed.
- Keep MCP as one consumer of the generic model, not a special case.

## V1 Compromise

For the first Project MCP Server Entry Point implementation, keep the boundary
simple:

- `ProjectMcpServerEntrypoint` owns Clerk OAuth protocol verification.
- It calls a generic Project Durable Object Project Access Check after verifying
  the Clerk principal.
- The Project Access Check may use the app-level D1 `projects` projection for a
  simple Project/Clerk Organization access check.
- Do not add MCP-specific authorization methods to the Project Durable Object.
- Track richer Project-owned scopes and destination authorization here.

## Non-goals

- Do not design a full policy language before Project ingress works end to end.
- Do not make MCP-specific auth the generic project authorization API.
