---
state: todo
priority: medium
size: medium
dependsOn: []
---

# OS2 Project DO Projection Reconciliation

## Context

OS2 Project lifecycle commands should go through the Project Durable Object.
For v1, the Project Durable Object can synchronously write global D1 ingress
rows as projections so the hot Worker path has a simple exact-host lookup.
The app-level `projects` table is also a projection written from Project
Durable Object lifecycle commands.

The shared durable-object-utils D1 object catalog is separate from those
application projections. It tracks initialized Durable Objects for discovery,
inspection, and repair workflows.

This is intentionally simple, but Durable Object SQLite and D1 are not one
atomic transaction. A command can record desired Project state and fail before
the global D1 projection is updated, or update D1 and fail before all local
state bookkeeping is complete.

## Goal

Add explicit correctness work for keeping Project Durable Object desired state
and global query projections aligned.

## Scope

- Define the Project Durable Object's desired ingress state shape.
- Define the app-level Project listing projection written by Project lifecycle
  commands.
- Define global D1 projection rows for exact-host ingress lookup.
- Add a reconciliation command that rebuilds one Project's global projection
  from the Project Durable Object's desired state.
- Add a bulk repair path using the D1 object catalog to enumerate Project
  Durable Objects.
- Mount the shared Durable Object utility routes needed for Project
  initialization, catalog reads, and repair workflows on the OS2 Worker
  entrypoint.
- Rename the current MCP server connection Durable Object/catalog class from
  `IterateMcpServer` to `ProjectMcpServerConnection` when implementing the new
  ingress entrypoint shape.
- Add observability for projection write failures and repair results.
- Add tests for partial-failure scenarios once the first implementation exists.

## Non-goals

- Do not introduce distributed transactions.
- Do not add complex async orchestration before the v1 Project ingress model is
  working end to end.
- Do not make global D1 the authority for project-owned ingress state.
- Do not conflate app-level Project projections with the shared Durable Object
  catalog tables.
