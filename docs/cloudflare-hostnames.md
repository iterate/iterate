# Cloudflare hostnames for OS

How `apps/os` hostnames are wired in Cloudflare: what deploy owns, what stays manual, and how the iterate.com website cutover works.

See also `docs/os-environments.md` for Doppler configs and zone naming per environment.

## Two routing layers

1. **Cloudflare worker routes** — which Worker script receives the request (`os-prd`, `iterate-website`, …).
2. **OS ingress** (`apps/os/src/entry.workerd.ts`) — what happens inside `os-prd` (D1 exact-host → platform `*.iterate.app` → `projects.custom_hostname` → TanStack dashboard).

`apps/os/alchemy.run.ts` only registers routes derived from AppConfig:

- `APP_CONFIG_BASE_URL` → dashboard host (e.g. `os.iterate.com`)
- `APP_CONFIG_PROJECT_HOSTNAME_BASES` → `<base>` and `*.<base>` (e.g. `iterate.app`, `*.iterate.app`)

It does **not** manage `iterate.com`. Do not add `iterate.com` to `projectHostnameBases`; that would make every deploy fight the shared `iterate.com` zone (auth, events, estates, marketing).

## Manual routes: `iterate.com` (prod)

Owned zone: `iterate.com` (prd account `04b3b57291ef2626c6a8daa9d47065a7`, zone id `7411e0284506d524241f82f844a63f45`).

| Pattern                                                                                            | Worker            | Notes                                                    |
| -------------------------------------------------------------------------------------------------- | ----------------- | -------------------------------------------------------- |
| `iterate.com/*`                                                                                    | `os-prd`          | Apex marketing → iterate project (via `custom_hostname`) |
| `*.iterate.com/*`                                                                                  | `os-prd`          | Single-label subdomains; exact routes win                |
| `os.iterate.com/*`                                                                                 | `os-prd`          | OS dashboard (`APP_CONFIG_BASE_URL`); unchanged          |
| `www.iterate.com/*`                                                                                | `iterate-website` | Marketing www; unchanged unless deliberately moved       |
| `auth.iterate.com/*`, `events.iterate.com/*`, `*.events.iterate.com/*`, estate `*.*.iterate.com/*` | various           | Leave as-is                                              |

Cloudflare wildcard `*.iterate.com` matches **one label** only (`foo.iterate.com`, not `platform.clone.iterate.com`). More specific patterns (e.g. `os.iterate.com/*`) take precedence.

### OS config for prod website (not Alchemy)

Doppler `os` / `prd`:

```text
APP_CONFIG_BASE_URL=https://os.iterate.com
APP_CONFIG_PROJECT_HOSTNAME_BASES=["iterate.app"]
```

On the **`iterate` project** (slug `iterate`), set:

```text
custom_hostname = iterate.com
```

via `os.projects.updateConfig` or D1. Do not use `projectHostnameBases` for this; custom hostname routing is separate from slug platform hosts (`myproj.iterate.app`).

Ingress then serves:

- `https://iterate.com` → iterate project (config worker when built)
- `https://<app>.iterate.com` → same project (`x-iterate-app-slug` from single-label prefix)
- `https://os.iterate.com` → OS dashboard (app hostname excluded from custom-hostname match)

### Reserved / future infra hosts

Hosts like `mcp.iterate.com` are **not** required for the website cutover. With `custom_hostname = iterate.com`, `mcp.iterate.com` already hits `os-prd` via `*.iterate.com/*` but is handled as a **project app subdomain**, not the global OS MCP entrypoint. Prefer `mcp__iterate.iterate.app` until we add an explicit `APP_CONFIG_*` reserved host (same idea as `baseUrl` for the dashboard).

## Preview parity

Preview dashboard: `os.iterate-preview-N.com` on zone `iterate-preview-N.com`.  
Preview project hosts: `*.iterate-preview-N.app` (Alchemy-managed).

To mirror prod on preview slot **N**:

1. Manual routes on zone `iterate-preview-N.com`:
   - `iterate-preview-N.com/*` → `os-preview-N`
   - `*.iterate-preview-N.com/*` → `os-preview-N`
2. Seed or reuse project slug `iterate` with `custom_hostname = iterate-preview-N.com`.
3. Run preview e2e (see `tasks/os-iterate-com-custom-domain-preview-e2e.md`).

## API maintenance

List routes:

```bash
doppler run --project _shared --config prd -- bash -c '
ZONE_ID="7411e0284506d524241f82f844a63f45"
curl -sS -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
  "https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/workers/routes" \
  | jq "[.result[] | select(.pattern | test(\"^iterate\\.com|^\\\\*\\\\.iterate\\.com|^os\\\\.iterate\\.com\")) | {id, pattern, script}]"
'
```

Update apex route script:

```bash
# PUT /zones/{zone_id}/workers/routes/{route_id}  body: {"pattern":"iterate.com/*","script":"os-prd"}
```

Create wildcard route:

```bash
# POST /zones/{zone_id}/workers/routes  body: {"pattern":"*.iterate.com/*","script":"os-prd"}
```

## Audit log

| Date       | Change                                                                                     |
| ---------- | ------------------------------------------------------------------------------------------ |
| 2026-05-18 | `iterate.com/*` `iterate-website` → `os-prd` (route id `d1718fdf50794525a52fd2a965d2a01a`) |
| 2026-05-18 | Added `*.iterate.com/*` → `os-prd` (route id `8e519e5caacf47eda0e48c7bad0ad10b`)           |
