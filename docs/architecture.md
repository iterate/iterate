# Architecture

The iterate platform is a Cloudflare Workers control plane plus project-scoped runtime APIs.

`apps/os2` is the primary product app. It provides the authenticated web UI, oRPC APIs, Clerk auth integration, D1/sqlfu projections, and Durable Objects for project lifecycle, ingress, MCP sessions, codemode sessions, and shared streams.

Other Cloudflare apps in the monorepo (`agents`, `events`, `semaphore`, `example`, etc.) provide supporting services and reference implementations.

See `apps/os2/AGENTS.md` and `apps/os2/docs/architecture-and-operations.md` for OS2-specific details.
