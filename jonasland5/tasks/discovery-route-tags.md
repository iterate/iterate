---
state: todo
priority: high
size: small
tags:
  - jonasland5
  - discovery
  - routing
dependsOn:
  - discovery-sqlite-config-foundation.md
---

# Add arbitrary route tags (string[]) to discovery service

## Scope

- Extend route contract/schema to include `tags: string[]` (optional on input, normalized to array in storage/output).
- Persist tags in SQLite-backed route records.
- Keep metadata support intact.

## Acceptance criteria

- `routes.upsert` accepts tags and persists them.
- `routes.remove` behavior unchanged.
- Route outputs include normalized tags array.
- Add tests for tags persistence, default empty tags, and update/replace semantics.
