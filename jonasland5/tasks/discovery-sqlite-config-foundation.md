---
state: todo
priority: high
size: medium
tags:
  - jonasland5
  - discovery
  - sqlite
dependsOn: []
---

# Add SQLite persistence + central config table to discovery service

## Scope

- Add SQLite storage to `jonasland5/sandbox/services/services-service.ts` (or adjacent module) for route state and config state.
- Create DB bootstrap/migration logic for at least:
  - `routes` table (host, target, metadata JSON)
  - `config` table (key, value JSON/text, updated_at)
- Keep process startup simple: open DB, ensure schema, then serve RPC.

## Acceptance criteria

- Discovery service can restart without losing routes/config.
- A typed RPC surface exists for config read/write (minimal: `get`, `set`, optional `list`).
- Service still supports current route upsert/remove/load invocation behavior.
- Add tests covering schema bootstrap and config persistence behavior.
