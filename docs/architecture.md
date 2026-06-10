# Architecture

The iterate platform is a Cloudflare Workers control plane plus project-scoped runtime APIs.

`apps/os` is the primary product app. It provides the authenticated web UI, oRPC APIs, Iterate Auth Worker integration, D1/sqlfu projections, and Durable Objects for project lifecycle, ingress, MCP sessions, codemode sessions, and shared streams.

Other workspace apps provide supporting services and reference implementations: `apps/auth` (the Iterate Auth Worker — identity, organizations, OAuth), `apps/semaphore` (lease/lock service, e.g. preview slots and tunnel pools), `apps/iterate-com` (marketing site), and `apps/auth-example` (auth integration reference). Apps with public APIs pair with a `*-contract` package (`apps/os-contract`, `apps/auth-contract`, `apps/semaphore-contract`) holding the shared client-facing types.

See `apps/os/AGENTS.md` and `apps/os/docs/architecture-and-operations.md` for OS-specific details.
