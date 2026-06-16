# Ingress Domain

Ingress maps public request hostnames to one of the OS lanes:

- known OS host -> app worker
- MCP host/path -> MCP worker
- itx capability host -> project-host worker
- project platform/custom host -> project-host worker
- anything else -> 404

The implementation lives in `apps/os/src/workers/shared/router.ts`. The D1
lookup is intentionally narrow: once the hostname shape is known to be project
ingress, the router resolves `projects.slug`, `projects.id`, or
`projects.custom_hostname` to a project id and optional app slug.
