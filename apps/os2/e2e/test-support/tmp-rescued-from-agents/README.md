# Rescued agents e2e helpers

Raw copies from `apps/agents` kept here so `apps/agents` can be deleted without losing useful test
infrastructure, historical fixtures, or design notes.

These files are intentionally not imported by OS2 tests yet. Before using one, move it out of this
folder and adapt agents-specific assumptions such as Events service URLs, agents contracts, default
MCP endpoints, or alchemy health checks.

Contents:

- Root files: agents e2e helper copies and Vitest shims.
- `docs/`: stream processor authoring guide.
- `scripts/`: agents-only smoke scripts.
- `src-lib/`: small agents-only library helpers and tests.

Not copied by default:

- `src/durable-objects/`: old agents runner implementations. OS2 has domain-specific replacements;
  copy these separately only if a concrete parity gap appears.
- Agents app README and HAR snapshots: intentionally omitted.
