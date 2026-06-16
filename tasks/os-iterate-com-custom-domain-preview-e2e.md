---
state: todo
priority: high
size: medium
dependsOn: []
tags: [cloudflare, os, e2e, preview, iterate.com]
---

# Preview e2e: iterate project on custom apex hostname

Prod website cutover uses manual Cloudflare routes on `iterate.com` plus `custom_hostname = iterate.com` on the `iterate` OS project. See `docs/devops-cloudflare-doppler-alchemy-setup.md`.

This task adds **preview e2e** coverage for the same ingress shape on a preview slot (default example: **preview_2** → `iterate-preview-2.com`).

## Goal

Prove end-to-end that:

1. A project with slug `iterate` and `custom_hostname` set to the preview **`.com` apex** (e.g. `iterate-preview-2.com`) is reachable on that hostname through the deployed preview worker.
2. The OS dashboard host for that slot (`os.iterate-preview-2.com`) still serves the TanStack app, not the iterate project worker.
3. A single-label subdomain on the preview `.com` zone (e.g. `smoke.iterate-preview-2.com`) routes to the same iterate project when `custom_hostname` is set.

## Prerequisites

### Cloudflare (per preview slot N)

On zone `iterate-preview-N.com` (preview account), manual routes — **not** via `alchemy.run.ts`:

| Pattern                     | Worker         |
| --------------------------- | -------------- |
| `iterate-preview-N.com/*`   | `os-preview-N` |
| `*.iterate-preview-N.com/*` | `os-preview-N` |

Leave `os.iterate-preview-N.com/*` on `os-preview-N` (Alchemy / `APP_CONFIG_BASE_URL`).

### Doppler

`os` / `preview_N` should keep project bases on the `.app` zone only, e.g. `APP_CONFIG_PROJECT_HOSTNAME_BASES=["iterate-preview-2.app"]`, `APP_CONFIG_BASE_URL=https://os.iterate-preview-2.com`.

### Iterate project + config worker

- Project slug `iterate` must exist on the target preview (create in test or document one-time seed).
- `iterate-config` repo attached and `config-worker-built` lifecycle event fired, or test asserts the documented building/fallback response until worker is ready.

## Test design

Add `apps/os/e2e/vitest/iterate-custom-apex-hostname.e2e.test.ts` (name flexible) run via existing preview e2e lane:

```bash
OS_BASE_URL=https://os.iterate-preview-2.com pnpm --dir apps/os e2e
```

### Env

| Var                       | Purpose                                                                                             |
| ------------------------- | --------------------------------------------------------------------------------------------------- |
| `OS_BASE_URL`             | Preview dashboard URL (`https://os.iterate-preview-2.com`)                                          |
| `OS_E2E_CUSTOM_APEX_HOST` | Preview `.com` apex, e.g. `iterate-preview-2.com`                                                   |
| Admin secret              | Same as `admin-project.itx.e2e.test.ts` (`OS_E2E_ADMIN_API_SECRET` / `APP_CONFIG_ADMIN_API_SECRET`) |

Derive `OS_E2E_CUSTOM_APEX_HOST` from `OS_BASE_URL` when possible (`os.iterate-preview-2.com` → `iterate-preview-2.com`) so one env var is enough.

### Fixture

Use `createTestProject` from `apps/os/e2e/test-support/create-test-project.ts`:

- `slugPrefix` or fixed slug `iterate` (handle collision: find existing by slug or delete-on-dispose only when test created it).
- `customHostname: process.env.OS_E2E_CUSTOM_APEX_HOST` (or derived apex).
- `cleanup: true` unless using a shared long-lived preview seed project.

### Cases

1. **Apex** — `GET https://{apex}/` returns project ingress (200; body matches config worker or documented building state, not OS dashboard HTML).
2. **Dashboard unchanged** — `GET https://os.iterate-preview-N.com/` still OS (login redirect or known dashboard marker; not project worker body).
3. **Single-label app host** — `GET https://app-smoke.{apex}/` hits same project (optional if config worker exposes a stable test path).

Skip suite when `OS_BASE_URL` or admin secret missing (same pattern as `admin-project.itx.e2e.test.ts`).

## Non-goals

- Prod `iterate.com` live test in CI (manual routes + prod project are ops-owned).
- `mcp.{apex}` global MCP URL (defer until `APP_CONFIG_*` reserved host exists).
- Cloudflare Custom Hostnames SSL API for owned zones (see `docs/devops-cloudflare-doppler-alchemy-setup.md` / owned-zone provisioning follow-up).

## Acceptance

- [ ] Preview e2e spec merged and documented in `apps/os/e2e/AGENTS.md` one line.
- [ ] CI or `pnpm preview test` path can run it when preview_2 (or chosen slot) is deployed with manual `.com` routes.
- [ ] Failure modes are obvious (missing route, missing `custom_hostname`, config worker not built).
