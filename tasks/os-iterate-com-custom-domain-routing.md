---
state: open
priority: high
size: medium
dependsOn: []
---

# Route iterate.com to the iterate project dynamic worker

Prod `apps/os` is deployed. Project slug `iterate` exists. Goal: serve the
project's iterate-config dynamic worker on `iterate.com` and single-label
`*.iterate.com` subdomains, without breaking more specific `iterate.com` routes
(`os.iterate.com`, `www.iterate.com`, `auth.iterate.com`, estate hosts, etc.).

## How routing works

Two layers:

1. **Cloudflare worker routes** — which script receives the request.
2. **OS ingress** (`apps/os/src/entry.workerd.ts`) — which project handles it
   inside `os-prd`.

Prod Doppler (`os` / `prd`) today:

- `APP_CONFIG_BASE_URL=https://os.iterate.com`
- `APP_CONFIG_PROJECT_HOSTNAME_BASES=["iterate.app"]`

Cloudflare prod today (iterate.com zone):

- `os.iterate.com/*` → `os-prd`
- `iterate.app/*`, `*.iterate.app/*` → `os-prd`
- `iterate.com/*`, `www.iterate.com/*` → `iterate-website`
- `auth.iterate.com/*` → `auth-prd`
- `events.iterate.com/*`, `*.events.iterate.com/*` → `events-prd`
- many explicit estate `*.something.iterate.com/*` routes
- no `*.iterate.com/*` catch-all on `os-prd`

Inside `os-prd`, ingress order:

```text
D1 exact-host rule
  → platform host (*.iterate.app slug routing)
  → custom_hostname DB lookup
  → TanStack OS dashboard fallback
```

Custom domain routing already exists: `projects.custom_hostname` →
`ProjectIngressEntrypoint` → `ProjectDurableObject.ingressFetch()` →
iterate-config dynamic worker.

## Do not

- Add `iterate.com` to `APP_CONFIG_PROJECT_HOSTNAME_BASES`. That makes Alchemy
  manage `iterate.com/*` and `*.iterate.com/*` on every deploy and fights the
  shared iterate.com zone (marketing, auth, events, estates).
- Change `alchemy.run.ts` for this unless we add a separate explicit knob for
  owned-zone routes. Current `projectRouteHostnamesForBase()` only expands
  `projectHostnameBases` (`iterate.app` + `*.iterate.app`).

## Cloudflare (manual)

In the `iterate.com` zone:

| Action | Route                                                                        | Worker                       |
| ------ | ---------------------------------------------------------------------------- | ---------------------------- |
| Change | `iterate.com/*`                                                              | `iterate-website` → `os-prd` |
| Add    | `*.iterate.com/*`                                                            | `os-prd`                     |
| Leave  | `os.iterate.com/*`, `www.iterate.com/*`, `auth.*`, `events.*`, estate routes | unchanged                    |

Cloudflare wildcard limits:

- `*.iterate.com` matches one label only (`foo.iterate.com`, `os.iterate.com`).
  Exact routes like `os.iterate.com/*` win over the wildcard.
- Does not match multi-label hosts like `platform.clone.iterate.com` — those
  already have explicit routes.

DNS: worker routes need proxied DNS. Many subdomains already have records. Add a
proxied `*.iterate.com` wildcard if new one-level subdomains need to resolve.
Alchemy will not create iterate.com DNS if `iterate.com` stays out of
`projectHostnameBases`.

Tradeoff: apex `iterate.com` leaves `iterate-website`. `www.iterate.com` stays
on marketing unless that route is also changed.

## Project config (DB)

Set on the `iterate` project:

```text
custom_hostname = 'iterate.com'
```

via `os.projects.updateConfig` or D1.

Do not use `projectHostnameBases` for this — that path is slug-based platform
hosts (`myproj.iterate.app`), not owned-zone custom domains.

Validation: `isReservedProjectHostname` only blocks `iterate.app` suffixes.
`isBlockedCustomDomain("iterate.com")` exists in `packages/shared` but is not
wired into OS validation.

Once set, app routing matches:

- `iterate.com` → iterate project
- single-label subdomains (`opencode.iterate.com`, etc.) → iterate project
- `os.iterate.com` → excluded (`host === appHostname` check) → OS dashboard

Every other single-label subdomain hitting `os-prd` without a more specific CF
route also lands on the iterate project. Intentional catch-all side effect.

## Doppler

No change required:

```text
APP_CONFIG_BASE_URL=https://os.iterate.com
APP_CONFIG_PROJECT_HOSTNAME_BASES=["iterate.app"]
```

Keep `APP_CONFIG_CLOUDFLARE__API_TOKEN` set if using custom-hostname provisioning
APIs.

## Known issues / follow-ups

### Custom Hostnames SSL API is wrong for owned zones

`updateConfig` calls `ensureProjectCustomHostnameStatus`, which registers the
hostname as a Custom Hostname on the `iterate.app` zone (SSL-for-SaaS, target
`cname.iterate.app`). For a domain we own (`iterate.com` zone), that is
unnecessary and may fail or create junk entries — TLS is handled by the
iterate.com zone once traffic routes to `os-prd`.

Follow-up: skip Custom Hostnames provisioning when the custom domain is a zone we
control. Short-term workaround: set `custom_hostname` via SQL and skip the API
call, or tolerate provisioning errors.

### Clerk / auth

OS dashboard stays on `os.iterate.com`. If the iterate-config worker on
`iterate.com` needs OAuth/MCP/browser auth on that origin, update Clerk allowed
origins / redirects (`apps/os/scripts/sync-clerk-apps.ts` does not cover custom
project domains today).

### iterate-config worker readiness

Routing alone is not enough. Confirm iterate-config repo is attached and the
config worker is built (`config-worker-built` lifecycle event). Otherwise ingress
serves the building/landing fallback.

## Rollout checklist

1. Set `custom_hostname = 'iterate.com'` on the iterate project.
2. CF routes: add `*.iterate.com/*` → `os-prd`; flip `iterate.com/*` from
   `iterate-website` → `os-prd`.
3. Verify DNS (apex + wildcard if needed).
4. Smoke-test:
   - `https://iterate.com` → iterate dynamic worker
   - `https://os.iterate.com` → OS dashboard
   - `https://www.iterate.com` → marketing site
   - `https://auth.iterate.com`, `https://events.iterate.com` → unchanged
   - `https://<app>.iterate.com` → iterate dynamic worker
5. Fix owned-zone Custom Hostnames provisioning (code).
6. Update Clerk only if the project worker needs auth on `iterate.com`.
