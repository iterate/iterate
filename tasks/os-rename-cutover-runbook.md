---
state: draft
priority: high
size: large
dependsOn: []
tags: [os-rename, runbook]
---

# OS rename cutover runbook (`os2` → `os`)

Permanent reference for the one-PR cutover. Working checklist: `tasks/os-rename-WIP-checklist.md` (deleted when done).

## Decisions (grill-me)

| Topic              | Decision                                                                                         |
| ------------------ | ------------------------------------------------------------------------------------------------ |
| Doppler root `os`  | Rename → `os-legacy-backup`; CI repoint; follow-up `tasks/doppler-os-legacy-backup-migration.md` |
| Doppler `os2`      | Rename → `os`                                                                                    |
| Prod data          | Wipe; destroy/recreate CF                                                                        |
| Hostnames          | `os.iterate.com`, `*.iterate.app`, `os.iterate-preview-N.com`, dev tunnels unchanged             |
| Rename scope       | Full grep wipe                                                                                   |
| Preview            | Destroy/recreate                                                                                 |
| Dev                | Leave tunnel stacks alone                                                                        |
| PRs                | One PR                                                                                           |
| Clerk              | Rename all apps to `OS *`                                                                        |
| Cross-app bindings | Update all + redeploy dependents                                                                 |
| DNS                | Zones exist; decruft `tasks/dns-zones-decruft-iterate-hostnames.md`                              |

## Order of operations

1. Doppler: rename projects (`os` → `os-legacy-backup`, `os2` → `os`).
2. Land code PR (or work on branch): paths, packages, grep, CI, Doppler yaml, hostnames in configs.
3. Update Doppler secrets (prd/preview URLs) on project `os`.
4. `alchemy:down` / destroy `os2-prd`, preview workers, legacy `os` worker if present.
5. Deploy `os-prd`, `os-preview-*`; redeploy `events-prd`, others with updated bindings.
6. `sync-clerk-apps.ts` with new names/URLs.
7. DNS decruft (task).
8. CF worker sweep (task).
9. Doppler audit (task).

## Commands

```bash
# Clerk sync (requires `clerk auth login` or CLERK_PLATFORM_API_KEY in env)
doppler run --project os --config prd -- pnpm --dir apps/os exec tsx ./scripts/sync-clerk-apps.ts

# Prod deploy (after Alchemy state — see below)
doppler run --project os --config prd -- pnpm --dir apps/os cf:deploy

# Preview slot example
doppler run --project os --config preview_2 -- pnpm --dir apps/os cf:deploy

# Events redeploy after os-prd exists
doppler run --project events --config prd -- pnpm --dir apps/events cf:deploy
```

## Alchemy state after slug `os2` → `os`

If deploy fails with `Unsupported state or unable to authenticate data`, Cloudflare
state for `os/prd` may be legacy/corrupt (old `os` monorepo app) or encrypted under
`os2`. Fix: delete remote Alchemy state for `os2/prd` and `os/prd` in the state store
(KV / `alchemy-state-service` worker — see Cloudflare dashboard), then deploy fresh
`os-prd`. Old workers `os2-prd` / `os2-preview-*` can be deleted per
`tasks/cf-prd-orphaned-resources-cleanup.md`.

## Completed in repo (2026-05-18)

- Doppler: `os` → `os-legacy-backup`, `os2` → `os`
- `apps/os2` → `apps/os`, `os2-contract` → `os-contract`, full grep wipe
- Doppler `os` prd/preview hostnames + events `DEPLOYMENT_CONFIG_*=os-prd`
- CI default Doppler project for monorepo jobs: `os-legacy-backup`

## Still manual

- [ ] Clerk sync (CLI auth)
- [ ] Clear Alchemy state + deploy `os-prd`, previews, `events-prd`
- [ ] DNS decruft (`tasks/dns-zones-decruft-iterate-hostnames.md`)
- [ ] CF worker sweep (`tasks/cf-prd-orphaned-resources-cleanup.md`)
