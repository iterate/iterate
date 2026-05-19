# os Environment Model

An os **environment** is a bag of env vars (a Doppler "config") plus some cloud resources (Cloudflare worker, D1 database, DNS records). PR previews also use Semaphore for environment config leases.

## Domain structure

Every environment serves two roles via two domains:

| Role               | Pattern         | Example (prod)       | Example (dev-jonas)            | Example (preview-3)            |
| ------------------ | --------------- | -------------------- | ------------------------------ | ------------------------------ |
| Dashboard          | configured host | `os.iterate.com`     | `os.iterate-dev-jonas.com`     | `os.iterate-preview-3.com`     |
| Project subdomains | `<proj>.<zone>` | `<proj>.iterate.app` | `<proj>.iterate-dev-jonas.app` | `<proj>.iterate-preview-3.app` |

The design principle: **dev must structurally mirror production.** Each environment
gets one dashboard hostname and one project-hostname base. Numbered previews use
dedicated zone pairs: `iterate-preview-N.com` for the dashboard and
`iterate-preview-N.app` for project/MCP hosts.

## AppConfig

Domain identity lives in `AppConfig` (runtime config available to the worker):

- `baseUrl` — canonical dashboard URL (e.g. `https://os.iterate.com`). Used for generating links in emails, redirects, etc. Optional — when absent (local dev without tunnel), the worker infers from the request.
- `projectHostnameBases` — array of project host bases. Normal bases match `<project>.<base>` (e.g. `["iterate.app"]`). Preview bases are normal bases too, e.g. `["iterate-preview-3.app"]`.

At deploy time, `alchemy.run.ts` reads AppConfig and derives Cloudflare worker routes from these two fields. No separate `WORKER_ROUTES` env var is needed for os route computation.

## Cloudflare accounts

See [Cloudflare accounts](cloudflare-accounts.md) for the repo-wide credential
model.

os reads Cloudflare credentials from the `_shared` Doppler config inherited by
the active app config. App configs must not define local
`CLOUDFLARE_ACCOUNT_ID` or `CLOUDFLARE_API_TOKEN` overrides.

The current account split is:

- `_shared/dev` and `_shared/preview` use account `376ef7ed81b0573f93524de763666c15`
- `_shared/dev_*` and `_shared/preview_*` do not define Cloudflare credentials directly
- `_shared/prd` uses account `04b3b57291ef2626c6a8daa9d47065a7`

The API token (`cfut_...` user token) must have:

- Zone : DNS : Edit
- Zone : Zone : Read
- Account : Cloudflare Tunnel : Edit

Note: Account-level tokens (`cfat_*`) do NOT work for zone-level DNS operations. Use a user-level token (`cfut_*`).

## Doppler project: `os`

### Config hierarchy

```
_shared          ← CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN, ALCHEMY_STAGE=${DOPPLER_CONFIG}
├── dev          ← ALCHEMY_LOCAL=true, base dev settings
│   ├── dev_jonas   ← APP_CONFIG_BASE_URL, APP_CONFIG_PROJECT_HOSTNAME_BASES
│   ├── dev_misha
│   └── dev_rahul
├── preview      ← ALCHEMY_LOCAL=false, preview base
│   ├── preview_2    ← preview environment 2: os.iterate-preview-2.com / <project>.iterate-preview-2.app
│   ├── ...
│   └── preview_9    ← preview environment 9
└── prd          ← os.iterate.com / iterate.app
```

### Key env vars per config type

| Var                                 | dev_jonas                          | preview_N                          | prd                              |
| ----------------------------------- | ---------------------------------- | ---------------------------------- | -------------------------------- |
| `APP_CONFIG_BASE_URL`               | `https://os.iterate-dev-jonas.com` | `https://os.iterate-preview-N.com` | `https://os.iterate.com`         |
| `APP_CONFIG_PROJECT_HOSTNAME_BASES` | `["iterate-dev-jonas.app"]`        | `["iterate-preview-N.app"]`        | `["iterate.app"]`                |
| `ALCHEMY_LOCAL`                     | `true`                             | `false`                            | `false`                          |
| `ALCHEMY_STAGE`                     | inherited as `${DOPPLER_CONFIG}`   | inherited as `${DOPPLER_CONFIG}`   | inherited as `${DOPPLER_CONFIG}` |

## Local development

### With tunnel (recommended)

```bash
# Uses your dev_jonas config — tunnel is created automatically because baseUrl is set
doppler run --project os --config dev_jonas -- tsx ./alchemy.run.ts
# Or simply:
cd apps/os && pnpm dev
```

The tunnel is enabled when `baseUrl` in AppConfig points to a real (non-localhost) domain. Alchemy creates a Cloudflare Tunnel, sets up DNS CNAMEs, and spawns `cloudflared`.

Prerequisites:

- `cloudflared` installed (`brew install cloudflared`)
- Doppler CLI configured with access to the `os` project
- Your `dev_<username>` config has `APP_CONFIG_BASE_URL` and `APP_CONFIG_PROJECT_HOSTNAME_BASES` set

### Without tunnel

Remove `APP_CONFIG_BASE_URL` from your config (or use the base `dev` config). Vite runs on localhost; no tunnel or DNS is created.

```bash
doppler run --project os --config dev -- tsx ./alchemy.run.ts
```

### Port

Vite picks a free port automatically (defaults to 5173, increments if taken). The tunnel points at whatever port Vite lands on.

## Preview environments

Preview environments use a shared Semaphore-controlled environment config lease inventory. The
current inventory is `preview-1` through `preview-9`, each with
`data.dopplerConfig` pointing at `preview_1` through `preview_9`. `preview_10`
is not leased because its os domain pair is not fully configured in the right
Cloudflare account.

### How it works

1. CI acquires a shared environment config lease from Semaphore (e.g. `preview-3`)
2. The resource data maps the lease to Doppler config `preview_3`
3. `preview_3` has `APP_CONFIG_BASE_URL=https://os.iterate-preview-3.com` and `APP_CONFIG_PROJECT_HOSTNAME_BASES=["iterate-preview-3.app"]`
4. `doppler run --project os --config preview_3 -- pnpm tsx ./alchemy.run.ts` deploys the worker with correct routes. `ALCHEMY_STAGE` comes from `_shared` as `${DOPPLER_CONFIG}` and is slugified by the app into Cloudflare names like `os-preview-3`.
5. PR body is updated with the shared lease and per-app deployment status
6. On PR close, recorded apps are torn down and the environment config lease is released back to Semaphore

### Cloudflare zones for previews

Each numbered os preview config uses two Cloudflare zones:

- `iterate-preview-N.com` for the dashboard host `os.iterate-preview-N.com`
- `iterate-preview-N.app` for project and MCP hosts like `<project>.iterate-preview-N.app`

Both zones must exist in the preview Cloudflare account configured by
`_shared/preview` before that config can deploy routes and DNS records.

os and events are deployed as one connected preview group when either both are
affected or os is selected. os owns its stream Durable Object namespace.
Events may point `DEPLOYMENT_CONFIG_STREAM_DURABLE_OBJECT_BINDING_SCRIPT_NAME`
at the os Worker script for the same numbered slot.

### Manual preview deploy

The `pnpm preview` CLI (from repo root) manages the full lifecycle. It uses the `os` doppler project for semaphore credentials:

```bash
# Check which environment config leases are free
doppler run --project _shared --config prd -- pnpm preview status

# Full lifecycle for a PR (acquire lease, deploy affected apps, test, update PR body)
GITHUB_TOKEN="$(gh auth token)" doppler run --project _shared --config prd --preserve-env=GITHUB_TOKEN -- pnpm preview sync --pull-request-number 1234

# Or just deploy without tests
GITHUB_TOKEN="$(gh auth token)" doppler run --project _shared --config prd --preserve-env=GITHUB_TOKEN -- pnpm preview deploy --pull-request-number 1234

# Clean up
GITHUB_TOKEN="$(gh auth token)" doppler run --project _shared --config prd --preserve-env=GITHUB_TOKEN -- pnpm preview cleanup --pull-request-number 1234
```

Prefer the repo-root `pnpm preview` CLI so Semaphore owns the environment config
lease. A direct deploy to a specific `preview_N` config bypasses Semaphore and
can collide with a PR that owns the same lease; use it only for emergency
debugging after checking `pnpm preview status`.

```bash
cd apps/os
doppler run --project os --config preview_3 -- pnpm tsx ./alchemy.run.ts

# Hit it
open https://os.iterate-preview-3.com         # dashboard
open https://myproject.iterate-preview-3.app   # project subdomain

# Clean up
doppler run --project os --config preview_3 -- pnpm tsx ./alchemy.run.ts --destroy
```

### Adding a new developer

1. Buy/register `iterate-dev-<name>.com` and `iterate-dev-<name>.app` in the dev/preview account
2. Create doppler config: `doppler configs create dev_<name> --project os`
3. Set the OS domain vars. OS deploys its own stream Durable Object namespace
   from the main Worker script; do not set a stream binding override on OS.
   ```bash
   doppler secrets set \
     APP_CONFIG_BASE_URL="https://os.iterate-dev-<name>.com" \
     'APP_CONFIG_PROJECT_HOSTNAME_BASES=["iterate-dev-<name>.app"]' \
     --project os --config dev_<name>
   ```
4. If the Events app should inspect the same stream namespace, set
   `DEPLOYMENT_CONFIG_STREAM_DURABLE_OBJECT_BINDING_SCRIPT_NAME` on the matching
   Events dev config to the OS Worker script name.
5. Run `pnpm dev` — the tunnel and DNS are created automatically on first run
