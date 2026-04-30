# os2 Environment Model

An os2 **environment** is a bag of env vars (a Doppler "config") plus some cloud resources (Cloudflare worker, D1 database, DNS records). Preview environments also use Semaphore for slot management.

## Domain structure

Every environment serves two roles via two domains:

| Role               | Pattern         | Example (prod)        | Example (dev-jonas)            | Example (preview-3)            |
| ------------------ | --------------- | --------------------- | ------------------------------ | ------------------------------ |
| Dashboard          | configured host | `os.iterate2.com`     | `os.iterate-dev-jonas.com`     | `os2.iterate-preview-3.com`    |
| Project subdomains | `<proj>.<zone>` | `<proj>.iterate2.app` | `<proj>.iterate-dev-jonas.app` | `<proj>.iterate-preview-3.app` |

The design principle: **dev must structurally mirror production.** Each environment
gets one dashboard hostname and one project-hostname base. Preview slots use
dedicated zone pairs: `iterate-preview-N.com` for the dashboard and
`iterate-preview-N.app` for project/MCP hosts.

## AppConfig

Domain identity lives in `AppConfig` (runtime config available to the worker):

- `baseUrl` — canonical dashboard URL (e.g. `https://os.iterate2.com`). Used for generating links in emails, redirects, etc. Optional — when absent (local dev without tunnel), the worker infers from the request.
- `projectHostnameBases` — array of project host bases. Normal bases match `<project>.<base>` (e.g. `["iterate2.app"]`). Preview bases are normal bases too, e.g. `["iterate-preview-3.app"]`.

At deploy time, `alchemy.run.ts` reads AppConfig and derives Cloudflare worker routes from these two fields. No separate `WORKER_ROUTES` env var is needed for os2 route computation.

## Cloudflare accounts

All os2 zones (dev, preview, prod) live in account `04b3b57291ef2626c6a8daa9d47065a7`. The API token (`cfut_...` user token) must have:

- Zone : DNS : Edit
- Zone : Zone : Read
- Account : Cloudflare Tunnel : Edit

Note: Account-level tokens (`cfat_*`) do NOT work for zone-level DNS operations. Use a user-level token (`cfut_*`).

## Doppler project: `os2`

### Config hierarchy

```
_shared          ← CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN, ALCHEMY_STAGE=${DOPPLER_CONFIG}
├── dev          ← ALCHEMY_LOCAL=true, base dev settings
│   ├── dev_jonas   ← APP_CONFIG_BASE_URL, APP_CONFIG_PROJECT_HOSTNAME_BASES
│   ├── dev_misha
│   └── dev_rahul
├── preview      ← ALCHEMY_LOCAL=false, preview base
│   ├── preview_1    ← preview slot 1: os2.iterate-preview-1.com / <project>.iterate-preview-1.app
│   ├── preview_2    ← preview slot 2
│   ├── ...
│   └── preview_10   ← preview slot 10
└── prd          ← os.iterate2.com / iterate2.app
```

### Key env vars per config type

| Var                                 | dev_jonas                              | preview_N                              | prd                              |
| ----------------------------------- | -------------------------------------- | -------------------------------------- | -------------------------------- |
| `APP_CONFIG_BASE_URL`               | `https://os.iterate-dev-jonas.com`     | `https://os2.iterate-preview-N.com`    | `https://os.iterate2.com`        |
| `APP_CONFIG_EVENTS_BASE_URL`        | `https://events.iterate-dev-jonas.com` | `https://events-preview-N.iterate.com` | `https://events.iterate.com`     |
| `APP_CONFIG_PROJECT_HOSTNAME_BASES` | `["iterate-dev-jonas.app"]`            | `["iterate-preview-N.app"]`            | `["iterate2.app"]`               |
| `ALCHEMY_LOCAL`                     | `true`                                 | `false`                                | `false`                          |
| `ALCHEMY_STAGE`                     | inherited as `${DOPPLER_CONFIG}`       | inherited as `${DOPPLER_CONFIG}`       | inherited as `${DOPPLER_CONFIG}` |

## Local development

### With tunnel (recommended)

```bash
# Uses your dev_jonas config — tunnel is created automatically because baseUrl is set
doppler run --project os2 --config dev_jonas -- tsx ./alchemy.run.ts
# Or simply:
cd apps/os2 && pnpm dev
```

The tunnel is enabled when `baseUrl` in AppConfig points to a real (non-localhost) domain. Alchemy creates a Cloudflare Tunnel, sets up DNS CNAMEs, and spawns `cloudflared`.

Prerequisites:

- `cloudflared` installed (`brew install cloudflared`)
- Doppler CLI configured with access to the `os2` project
- Your `dev_<username>` config has `APP_CONFIG_BASE_URL` and `APP_CONFIG_PROJECT_HOSTNAME_BASES` set

### Without tunnel

Remove `APP_CONFIG_BASE_URL` from your config (or use the base `dev` config). Vite runs on localhost; no tunnel or DNS is created.

```bash
doppler run --project os2 --config dev -- tsx ./alchemy.run.ts
```

### Port

Vite picks a free port automatically (defaults to 5173, increments if taken). The tunnel points at whatever port Vite lands on.

## Preview environments

Preview environments use a semaphore-controlled pool. The inventory is
`os2-preview-1` through `os2-preview-10`.

### How it works

1. CI acquires a slot from Semaphore (e.g. `os2-preview-3`)
2. `derivePreviewEnvironment` maps slot 3 → Doppler config `preview_3`
3. `preview_3` has `APP_CONFIG_BASE_URL=https://os2.iterate-preview-3.com` and `APP_CONFIG_PROJECT_HOSTNAME_BASES=["iterate-preview-3.app"]`
4. `doppler run --config preview_3 -- pnpm alchemy:up` deploys the worker with correct routes. `ALCHEMY_STAGE` comes from `_shared` as `${DOPPLER_CONFIG}` and is slugified by the app into Cloudflare names like `os2-preview-3`.
5. PR body is updated with both `publicUrl` and `projectSubdomainUrl`
6. On PR close, the slot is released back to Semaphore and the worker is destroyed

### Cloudflare zones for previews

Each preview slot N uses two Cloudflare zones:

- `iterate-preview-N.com` for the dashboard host `os2.iterate-preview-N.com`
- `iterate-preview-N.app` for project and MCP hosts like `<project>.iterate-preview-N.app`

Both zones must exist in the `04b3` Cloudflare account before the preview slot
can deploy routes and DNS records.

### Manual preview deploy

The `pnpm preview` CLI (from repo root) manages the full lifecycle. It uses the `os` doppler project for semaphore credentials:

```bash
# Check which slots are free
doppler run --project os --config prd -- pnpm preview status

# Full lifecycle for a PR (acquire slot, deploy, test, update PR body)
doppler run --project os --config prd -- pnpm preview sync --app os2

# Or just deploy without tests
doppler run --project os --config prd -- pnpm preview deploy --app os2

# Clean up
doppler run --project os --config prd -- pnpm preview cleanup --app os2
```

For a quick manual deploy to a specific slot (bypassing semaphore):

```bash
cd apps/os2
doppler run --project os2 --config preview_3 -- pnpm alchemy:up

# Hit it
open https://os2.iterate-preview-3.com         # dashboard
open https://myproject.iterate-preview-3.app   # project subdomain

# Clean up
doppler run --project os2 --config preview_3 -- pnpm alchemy:down
```

### Adding a new developer

1. Buy/register `iterate-dev-<name>.com` and `iterate-dev-<name>.app` in the `04b3` account
2. Create doppler config: `doppler configs create dev_<name> --project os2`
3. Set the domain vars:
   ```bash
   doppler secrets set \
     APP_CONFIG_BASE_URL="https://os.iterate-dev-<name>.com" \
     'APP_CONFIG_PROJECT_HOSTNAME_BASES=["iterate-dev-<name>.app"]' \
     --project os2 --config dev_<name>
   ```
4. Run `pnpm dev` — the tunnel and DNS are created automatically on first run
