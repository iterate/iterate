---
state: todo
priority: medium
size: medium
dependsOn: []
tags: [os, appconfig, doppler, cleanup]
---

# Singular `projectHostnameBase` (drop `projectHostnameBases` array)

## Problem

`AppConfig.projectHostnameBases` is `string[]` and Doppler exposes
`APP_CONFIG_PROJECT_HOSTNAME_BASES` as a JSON array, e.g. `["iterate.app"]`.

Every environment uses **exactly one** base:

| Config       | Value                        |
| ------------ | ---------------------------- |
| `prd`        | `["iterate.app"]`            |
| `preview_N`  | `["iterate-preview-N.app"]`  |
| `dev_<user>` | `["iterate-dev-<user>.app"]` |

Nothing passes multiple bases in production. Call sites already treat it as
singular: `projectHostnameBases[0]` (DNS, MCP URLs, settings UI, oRPC), and
`flatMap` in `alchemy.run.ts` only matters when Alchemy registers `base` +
`*.base` for that one entry.

The array shape is leftover from an earlier “maybe multiple bases per deploy”
idea. It adds noise (`[0]`, JSON array in Doppler, plural naming) without
behavior we use. Custom apex hosts (`iterate.com`) are **`custom_hostname` on a
project**, not an extra entry in this list — see `docs/devops-cloudflare-doppler-alchemy-setup.md`.

## Goal

One required string per environment:

```ts
projectHostnameBase: publicValue(z.string().trim().min(1));
```

Env: `APP_CONFIG_PROJECT_HOSTNAME_BASE=iterate.app` (plain string, not JSON
array).

## Scope

- `apps/os/src/config.ts` — schema + rename
- `apps/os/alchemy.run.ts` — `projectRouteHostnamesForBase(projectHostnameBase)`
- Ingress / routing: `project-host-routing.ts`, worker entrypoints,
  `project-platform-host-routing.ts`, `project-durable-object.ts`
- oRPC context, `auth.ts`, UI (`settings`, `app-sidebar`, project list)
- `packages/iterate/src/os/claude-mcp.ts`, `apps/os/scripts/sync-auth-clients.ts`
- `scripts/preview/preview.ts` parse helpers
- Tests: replace array fixtures with a single string
- Doppler: migrate all `os` configs from JSON array to string (prd, preview*N,
  dev*\*)
- Docs: `docs/devops-cloudflare-doppler-alchemy-setup.md`,
  `apps/os/docs/architecture-and-operations.md`, task files that mention the old
  name

## Non-goals

- Changing how manual `iterate.com` routes work
- Merging `baseUrl` and `projectHostnameBase` into one field (dashboard `.com`
  vs project `.app` zones stay separate)
- Supporting multiple bases again without a deliberate design pass

## Acceptance

- [ ] No `projectHostnameBases` / `APP_CONFIG_PROJECT_HOSTNAME_BASES` in app code
- [ ] All Doppler `os` configs use `APP_CONFIG_PROJECT_HOSTNAME_BASE` string
- [ ] `pnpm typecheck` + `apps/os` tests pass
- [ ] Preview deploy still registers `iterate-preview-N.app` + `*.iterate-preview-N.app` routes
