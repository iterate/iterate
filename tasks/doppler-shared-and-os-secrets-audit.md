---
state: draft
priority: medium
size: medium
dependsOn: []
tags: [doppler, os-rename, security]
---

# Doppler audit: `_shared` and product `os` (was `os`)

## Context

During `apps/os2` → `apps/os` rename:

- Doppler `os` → `os` (product app configs).
- Legacy monorepo bucket `os` → `os-legacy-backup`.

Audit **`_shared`** and the **renamed product `os`** project for stale keys, duplicate inheritance, prd/dev leakage, and secrets that no longer match `apps/os/src/config.ts` `AppConfig`.

## Projects in scope

| Project                              | Role                                  | Configs                                                                                                              |
| ------------------------------------ | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `_shared`                            | Inherited by all apps (`INHERITABLE`) | `dev`, `dev_*`, `preview`, `preview_2`…`preview_10`, `prd`                                                           |
| `os` (today `os`)                    | Product app                           | `dev`, `dev_*`, `dev_localhost`, `preview`, `preview_2`…`preview_9`, `prd`                                           |
| `os-legacy-backup` (today root `os`) | Archive / CI shim                     | Many stale configs (`dev_claude`, `dev_codex`, …) — **out of scope except** confirm nothing copies from it into `os` |

## Baseline snapshot (2026-05-18)

### `_shared` / `prd` — 16 keys (looks sane)

```
ALCHEMY_LOCAL, ALCHEMY_PASSWORD, ALCHEMY_STAGE, ALCHEMY_STATE_TOKEN
APP_CONFIG_INTEGRATIONS__GOOGLE, APP_CONFIG_LOGS, APP_CONFIG_POSTHOG
CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN
POSTHOG_PERSONAL_API_KEY, POSTHOG_PROJECT_ID
SEMAPHORE_API_TOKEN, SEMAPHORE_BASE_URL
(+ DOPPLER_* meta)
```

- Preview configs `preview_2` vs `preview_3`: **no key drift** (symmetric diff 0).
- Preview account split: `_shared/preview` should use account `376ef7ed…`; `_shared/prd` uses `04b3b572…` — verify values per config, not just key names.

### `os` / `prd` — 28 keys (aligned with AppConfig)

Expected product keys (compare to `AppConfig` in `apps/os/src/config.ts`):

| Key                                           | Required for prd                                                    |
| --------------------------------------------- | ------------------------------------------------------------------- |
| `APP_CONFIG_BASE_URL`                         | yes — flip to `https://os.iterate.com` on rename                    |
| `APP_CONFIG_PROJECT_HOSTNAME_BASES`           | yes — `["iterate.app"]`                                             |
| `APP_CONFIG_CLERK__*`                         | yes                                                                 |
| `APP_CONFIG_OPEN_AI_API_KEY`                  | yes                                                                 |
| `APP_CONFIG_ADMIN_API_SECRET`                 | optional but used                                                   |
| `APP_CONFIG_INTEGRATIONS__GOOGLE` / `__SLACK` | if integrations enabled                                             |
| `APP_CONFIG_SLACK_BOT_TOKEN`                  | optional                                                            |
| `APP_CONFIG_CLOUDFLARE__API_TOKEN`            | optional override (also on `_shared`)                               |
| `APP_CONFIG_POSTHOG`                          | optional (also on `_shared`)                                        |
| `APP_CONFIG` (JSON blob)                      | prefer **not** duplicating flattened keys                           |
| `CLOUDFLARE_*`                                | inherited from `_shared`; delete app-level duplicates if identical  |
| `SEMAPHORE_*`                                 | duplicated on `_shared` — keep one place (recommend `_shared` only) |
| `POSTHOG_PERSONAL_*`                          | operator keys — confirm still needed on app project                 |

Per-user overrides (`dev_<user>`, etc.) should only carry personal integration
secrets or a stable `CAPTUN_TUNNEL_NAME`; they should not carry app/MCP/project
host URL overrides, Clerk keys, or extra legacy keys.

### Legacy `os` / `prd` — 104 keys, **84 not in `os/prd`**

Junk / deleted-app candidates (do **not** copy into product `os`):

```
DAYTONA_*, ARCHIL_*, BETTER_AUTH_SECRET, FLY_*, PLANETSCALE_*,
GITHUB_APP_*, E2B_API_KEY, DOCKER_DEFAULT_IMAGE, DEPOT_*,
INGRESS_PROXY_*, PROJECT_INGRESS_DOMAIN, PROXY_*_DOMAINS,
OS_WORKER_ROUTES, REGION_CONFIG, APP_STAGE, ...
```

Full diff command:

```bash
# After rename: replace os with os
doppler secrets --project os-legacy-backup --config prd --only-names > /tmp/legacy.txt
doppler secrets --project os --config prd --only-names > /tmp/product.txt
# Compare key sets (strip table formatting)
```

## Checklist

### `_shared`

- [ ] Every config: only keys listed in baseline (or documented additions).
- [ ] No `APP_CONFIG_*` keys for a single app (e.g. Clerk) — those belong on app `os`.
- [ ] `CLOUDFLARE_ACCOUNT_ID` / token: prd vs preview account IDs correct per `docs/devops-cloudflare-doppler-alchemy-setup.md`.
- [ ] `SEMAPHORE_API_TOKEN`: same token across configs intentional? Rotate if leaked in logs.
- [ ] `APP_CONFIG_INTEGRATIONS__GOOGLE` on `_shared`: still used by multiple apps or move to `os` only.
- [ ] Remove unused `preview_1` / `preview_10` if no matching lease slots.

### Product `os` (was `os`)

- [ ] Each `preview_N`: `APP_CONFIG_BASE_URL` uses `https://os.iterate-preview-N.com` (not `os.`).
- [ ] `dev` / `dev_*`: fully local by default (`APP_CONFIG_BASE_URL=http://localhost:<port>`, project hosts under `localhost`, local MCP at `<baseUrl>/api/__mcp`).
- [ ] `prd`: `https://os.iterate.com` + `["iterate.app"]`.
- [ ] No keys from legacy `os` bucket (run diff above after rename).
- [ ] Drop deprecated Clerk OAuth static keys if unset (`oauthClientId` / `oauthClientSecret` in schema).
- [ ] Resolve duplicate `APP_CONFIG` JSON vs flattened `APP_CONFIG_*` (pick one style).
- [ ] Remove app-level `CLOUDFLARE_*` / `SEMAPHORE_*` if identical to `_shared` inheritance.

### Cross-project

- [ ] `os-legacy-backup`: no inheritance into product `os`.
- [ ] Document which secrets CI reads now.

## Suspicious patterns to flag

| Pattern                                                     | Risk                                             |
| ----------------------------------------------------------- | ------------------------------------------------ |
| Same API key in `dev` and `prd`                             | Blast radius (see `tasks/ci-secrets-scoping.md`) |
| Production URLs in `dev` configs                            | Wrong redirects / webhooks                       |
| Keys in Doppler not referenced in code (`rg` secret name)   | Rotting credentials                              |
| Keys in code/env docs missing from Doppler                  | Broken deploys                                   |
| Personal configs (`dev_claude`, `dev_codex` on legacy `os`) | Delete or migrate off legacy project             |

## Code cross-check

```bash
# Env vars read by os app (after path rename)
rg 'APP_CONFIG_|process\.env\.' apps/os/src apps/os/alchemy.run.ts

# Shared config compiler
rg 'APP_CONFIG' packages/shared/src/apps/config.ts
```

## Acceptance

- `_shared/*`: minimal shared platform secrets only.
- `os/*`: only keys required by `AppConfig` + Alchemy deploy (`ALCHEMY_*`, inherited CF).
- Legacy junk stays in `os-legacy-backup` until deleted; never merged into `os`.
- Audit notes appended below with date + who ran it.

## Audit log

```
<!-- AUDIT_LOG -->
(pending)
```
