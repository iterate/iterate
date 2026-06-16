# Architecture

The iterate platform is a Cloudflare Workers control plane plus project-scoped runtime APIs.

`apps/os` is the primary product app. It provides the authenticated web UI, itx capability handles over `/api/itx`, Iterate Auth Worker integration, D1/sqlfu projections, and Durable Objects for project lifecycle, ingress, MCP sessions, agents, repositories, workspaces, itx contexts, and shared streams.

Other workspace apps provide supporting services and reference implementations: `apps/auth` (the Iterate Auth Worker — identity, organizations, OAuth), `apps/semaphore` (lease/lock service, e.g. preview slots and tunnel pools), `apps/iterate-com` (marketing site), and `apps/auth-example` (auth integration reference). Apps with public APIs may pair with a `*-contract` package holding shared client-facing types.

See `apps/os/AGENTS.md` and `apps/os/docs/architecture-and-operations.md` for OS-specific details.
