# Architecture

The iterate platform is a Cloudflare Workers control plane plus project-scoped runtime APIs.

`apps/os` is the primary product app. It provides the authenticated web UI, oRPC APIs, Iterate Auth Worker integration, D1/sqlfu projections, and Durable Objects for project lifecycle, ingress, MCP sessions, codemode sessions, and shared streams.

Other Cloudflare apps in the monorepo (`events`, `semaphore`, etc.) provide supporting services and reference implementations.

See `apps/os/AGENTS.md` and `apps/os/docs/architecture-and-operations.md` for OS-specific details.
