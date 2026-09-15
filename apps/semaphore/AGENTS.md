# Semaphore

Resource inventory in D1; one Durable Object coordinator per resource type owns leases, waiters and expiry.

- Keep D1 inventory and coordinator lease state coherent.
- Browser and CLI callers require Iterate admin identity; there is no shared API secret.
- `wrangler.jsonc` and `sql/.generated/` are generated. Use their source definitions and existing generators.

[Architecture, commands and auth](README.md) · [Environment configuration](../../docs/devops-cloudflare-doppler.md)
