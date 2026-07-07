---
status: in-progress
size: small
---

# Bump sqlfu to 0.1.1

Status summary: changes are already written and verified in a prior session (typecheck + tests green in both apps); this task file precedes the implementation commit so the PR tells the story.

## Why

The hosted sqlfu studio (sqlfu.dev/ui) crashed with `TypeError: Cannot read properties of undefined (reading 'filter')` when browsing tables served by our pinned `sqlfu@0.0.3-14` backend — the hosted UI (built from newer sqlfu) expects `foreignKeys`/`referencedBy` fields that `schema.get` only returns from 0.1.1. Upstream fix (supported-version floor + CI canary) is https://github.com/iterate/sqlfu/pull/151; on our side the fix is just moving to 0.1.1.

## Checklist

- [ ] bump `sqlfu` to `0.1.1` in `apps/auth` and `apps/semaphore` (the only two consumers)
- [ ] regenerate sqlfu codegen in both apps (`pnpm db:generate` / `pnpm sqlfu:generate`) — 0.1.1 adds snake_case→camelCase result mapping to generated query wrappers
- [ ] adapt `apps/semaphore/src/lib/resource-store.ts` — its hand-rolled `ResourceRow` type duplicated the mapping the codegen now does; switch its field names to the camelCase shape
- [ ] verify: `pnpm typecheck` + `pnpm test` in both apps

## Notes

- The camelCase result mapping is a runtime behavior change in generated wrappers, not just types. Auth's queries were already alias-friendly; semaphore's resource store is the most-affected call site.
- `sqlfu@0.1.1` requires Node 24+ at runtime despite declaring `engines: node >=22` (untranspiled `await using` in the published dist) — fine for us (deploy scripts and CI run newer), tracked upstream.
