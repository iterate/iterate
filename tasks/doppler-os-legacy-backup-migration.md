---
state: draft
priority: medium
size: medium
dependsOn: []
tags: [doppler, ci, os-rename]
---

# Doppler: retire root `os` project usage (os-legacy-backup follow-up)

## Context

The deleted legacy monorepo `os` worker left a large monorepo Doppler project `os` mapped to repo root (`./` in `doppler.yaml`). During `apps/os2` → `apps/os` rename we **repoint** existing `--project os` call sites to `os-legacy-backup` so the `os` slug is free for the product app (renamed from `os2`).

This task tracks moving live secrets off the legacy bucket and shrinking `os-legacy-backup` to archive-only.

## Interim decision (rename PR)

- Doppler: rename project `os` → `os-legacy-backup` (keep configs/secrets as-is).
- Doppler: rename project `os` → `os`, path `apps/os/` → `apps/os/`.
- All call sites below: `--project os` → `--project os-legacy-backup`.
- `doppler.yaml` root entry: `project: os-legacy-backup`, `path: ./`.

## Call sites to repoint (then delete from this list when migrated)

### CI workflows (generated — edit `.github/ts-workflows/` sources, run `pnpm workflows`)

| File                                                    | Config | Command / usage                                                                        |
| ------------------------------------------------------- | ------ | -------------------------------------------------------------------------------------- |
| `.github/workflows/cloudflare-previews.yml`             | `prd`  | `doppler run --project os …` ×3 (`preview deploy`, `test`, `cleanup`)                  |
| `.github/ts-workflows/workflows/cloudflare-previews.ts` | `prd`  | `prefix: "doppler run --project os --config prd -- "`                                  |
| `.github/workflows/test.yml`                            | `dev`  | `doppler setup --config dev --project os` then `doppler run -- pnpm test`              |
| `.github/workflows/deploy.yml`                          | `prd`  | `doppler setup --config prd --project os` → `apps/iterate-com` deploy                  |
| `.github/workflows/pullfrog.yml`                        | `dev`  | `doppler setup --config dev --project os`; reads `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` |

### Scripts

| File                                  | Config            | Usage                        |
| ------------------------------------- | ----------------- | ---------------------------- |
| `scripts/async-coding-agent-setup.sh` | `$DOPPLER_CONFIG` | `doppler setup --project os` |

### Docs / skills (operator copy-paste)

| File                                                |
| --------------------------------------------------- |
| `doppler.yaml` (comment + project name)             |
| `docs/cloudflare-preview-and-deploy-cheatsheet.md`  |
| `docs/cloudflare-preview-environments.md`           |
| `docs/os-environments.md` (rename doc when os → os) |
| `apps/semaphore/README.md`                          |
| `apps/iterate-com/README.md`                        |
| `apps/example/README.md` (commented example)        |
| `.agents/skills/creating-an-app/SKILL.md`           |

## Env vars actually consumed per consumer

Audit which of these are still required vs dead legacy from deleted `apps/os`.

### Preview orchestrator (`doppler run --project … --config prd -- pnpm preview …`)

Code: `scripts/preview/router.ts`, `scripts/preview/preview.ts`.

| Var                      | Source                                  | Notes                                                                                 |
| ------------------------ | --------------------------------------- | ------------------------------------------------------------------------------------- |
| `GITHUB_TOKEN`           | GitHub Actions (`preserve-env` in docs) | Not from Doppler                                                                      |
| `SEMAPHORE_API_TOKEN`    | Doppler                                 | Required for lease acquire/release; fallback `APP_CONFIG_SHARED_API_SECRET` in router |
| `SEMAPHORE_BASE_URL`     | Doppler                                 | Default `https://semaphore.iterate.com` in router                                     |
| `GITHUB_*` (PR metadata) | Actions env                             | `GITHUB_PR_NUMBER`, `GITHUB_SHA`, `GITHUB_REPOSITORY`, etc.                           |

Per-app preview **deploy** uses each app's Doppler project (`os`→`os`, `events`, …), not root legacy.

Reconcile reads Cloudflare creds from **app** `os` project: `scripts/preview/reconcile-environment-config-leases.ts` (`previewCloudflareCredentialsProject`).

**Target home:** `_shared` or renamed app `os` (`prd`), or tiny `preview` project — not 100+ legacy keys.

### `test.yml` (`doppler setup` + `doppler run -- pnpm test`)

Injects full `os`/`dev` env (~139 keys) into monorepo test run. Most tests likely ignore extras.

**Target home:** dedicated `ci` config (see `tasks/ci-secrets-scoping.md`) with minimal keys only.

### `deploy.yml` → `apps/iterate-com`

Website `package.json` uses `doppler run --config prd` (inherits setup from root).

**Target home:** dedicated Doppler project for `apps/iterate-com` (not product `os`).

### `pullfrog.yml` (`dev`)

| Var                 | Used in workflow                      |
| ------------------- | ------------------------------------- |
| `ANTHROPIC_API_KEY` | `doppler secrets get` → `$GITHUB_ENV` |
| `OPENAI_API_KEY`    | same                                  |

**Target home:** `pullfrog` or `ci` Doppler project.

## Legacy bucket contents (do not migrate wholesale)

`os-legacy-backup` / `prd` has ~104 secrets; `dev` ~139. Many are deleted-app cruft, e.g.:

`DAYTONA_*`, `ARCHIL_*`, `BETTER_AUTH_SECRET`, `GITHUB_APP_*`, `DOCKER_*`, `BIOS_BUILDER_*`, …

Also present and possibly still referenced by CI above:

`SEMAPHORE_API_TOKEN`, `SEMAPHORE_BASE_URL`, `ALCHEMY_STATE_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `APP_CONFIG_POSTHOG`, …

## Follow-up work

1. Rename Doppler project `os` → `os-legacy-backup` in Doppler UI/CLI.
2. For each consumer above, copy **only required** secrets to target project/config.
3. Switch consumer to new project; verify CI green.
4. Remove unused keys from `os-legacy-backup`; document archive date.
5. Overlap with `tasks/ci-secrets-scoping.md` (minimal `ci` config for `test.yml`).
6. Audit product `os` + `_shared`: `tasks/doppler-shared-and-os-secrets-audit.md`.

## Acceptance

- No production workflow depends on `os-legacy-backup` except explicit temporary shims (documented).
- `os` Doppler project maps only to `apps/os/` (product).
- `os-legacy-backup` either deleted or clearly archived with &lt;10 secrets.
