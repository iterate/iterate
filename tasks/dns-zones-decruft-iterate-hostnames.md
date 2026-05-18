---
state: done
priority: medium
size: medium
dependsOn: []
tags: [cloudflare, dns, os-rename]
---

# DNS / TLS decruft: iterate hostnames

## Context

`apps/os2` → `apps/os` cutover is complete on **`os.iterate.com`** + **`*.iterate.app`**. Legacy zones **`iterate2.com`** / **`iterate2.app`** are retired (no code or Doppler references remain).

Related: `tasks/cf-prd-orphaned-resources-cleanup.md`.

## Active zones

| Zone                     | Role                                             |
| ------------------------ | ------------------------------------------------ |
| `iterate.com`            | Prod dashboard `os.iterate.com`; other app hosts |
| `iterate.app`            | Prod project/MCP `*.iterate.app`                 |
| `iterate-preview-N.com`  | Preview dashboard `os.iterate-preview-N.com`     |
| `iterate-preview-N.app`  | Preview project hosts                            |
| `iterate-dev-<user>.com` | Dev dashboard (tunnels)                          |
| `iterate-dev-<user>.app` | Dev project hosts                                |

## Retired zones (do not add records)

| Zone           | Was               |
| -------------- | ----------------- |
| `iterate2.com` | `os.iterate2.com` |
| `iterate2.app` | `*.iterate2.app`  |

## Acceptance

- [x] Prod/preview on `iterate.com` / `iterate.app` / `iterate-preview-*` only
- [x] No `iterate2` in repo source or non-legacy Doppler
- [x] CF sweep: no `iterate2.*` zones or DNS/routes in prd account (see audit log)
- [ ] Optional: delete empty `iterate2.com` / `iterate2.app` zones in CF dashboard when sure nothing else uses them

## Audit log

```
2026-05-18: Repo grep — zero iterate2.com / iterate2.app in application code or non-legacy Doppler.
2026-05-18: CF prd account — iterate2.com / iterate2.app zones not present; swept iterate.com / iterate.app for iterate2 DNS and worker routes.
```
