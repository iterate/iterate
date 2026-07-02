# Architecture

The iterate platform is a Cloudflare Workers control plane plus project-scoped runtime APIs.

`apps/os` is the primary product app. It provides the authenticated web UI and itx (`apps/os/src/`): capability handles over `/api/itx`, and Durable Objects for project lifecycle, event streams, agents, repositories, secrets, dynamic workers, and itx capability scopes. OS has no database of its own — the Iterate Auth Worker is both the identity provider and the project directory (fronted by a KV cache); all other durable state is Durable Object SQLite.

Other workspace apps provide supporting services and reference implementations: `apps/auth` (the Iterate Auth Worker — identity, organizations, OAuth), `apps/semaphore` (lease/lock service, e.g. preview slots), `apps/iterate-com` (marketing site), and `apps/auth-example` (auth integration reference). Apps with public APIs may pair with a `*-contract` package holding shared client-facing types.

See `apps/os/AGENTS.md` and `apps/os/docs/architecture-and-operations.md` for OS-specific details.
