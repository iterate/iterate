# os2 Environment Model

An os2 **environment** is a bag of env vars (a Doppler "config") plus some cloud resources (Cloudflare worker, D1 database, DNS records). Preview environments also use Semaphore for slot management.

## Domain structure

Every environment serves two roles via two domains:

| Role               | Pattern             | Example (prod)        | Example (dev-jonas)            | Example (preview-3)            |
| ------------------ | ------------------- | --------------------- | ------------------------------ | ------------------------------ |
| Dashboard          | `os.<zone>.com`     | `os.iterate2.com`     | `os.iterate-dev-jonas.com`     | `os.iterate-preview-3.com`     |
| Project subdomains | `<proj>.<zone>.app` | `<proj>.iterate2.app` | `<proj>.iterate-dev-jonas.app` | `<proj>.iterate-preview-3.app` |

The design principle: **dev must structurally mirror production.** Each developer and each preview slot gets its own pair of `.com` + `.app` zones — no subdomain nesting.

## AppConfig

Domain identity lives in `AppConfig` (runtime config available to the worker):

- `baseUrl` — canonical dashboard URL (e.g. `https://os.iterate2.com`). Used for generating links in emails, redirects, etc. Optional — when absent (local dev without tunnel), the worker infers from the request.
- `projectHostnameBases` — array of base domains for project subdomains (e.g. `["iterate2.app"]`). The worker matches `Host` header against `*.<base>` to identify project requests.

At deploy time, `alchemy.run.ts` reads AppConfig and derives Cloudflare worker routes from these two fields. No separate `WORKER_ROUTES` env var is needed for route computation, though it's still set in Doppler for backwards compatibility with the deploy workflow metadata step.

## Cloudflare accounts

All os2 zones (dev, preview, prod) live in account `cc7f6f461fbe823c199da2b27f9e0ff3`. The API token (`cfut_...` user token) must have:

- Zone : DNS : Edit
- Zone : Zone : Read
- Account : Cloudflare Tunnel : Edit

Note: Account-level tokens (`cfat_*`) do NOT work for zone-level DNS operations. Use a user-level token (`cfut_*`).

## Doppler project: `os2`

### Config hierarchy

```
_shared          ← CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN, SEMAPHORE_*
├── dev          ← ALCHEMY_LOCAL=true, base dev settings
│   ├── dev_jonas   ← APP_CONFIG_BASE_URL, APP_CONFIG_PROJECT_HOSTNAME_BASES
│   ├── dev_misha
│   └── dev_rahul
├── stg          ← ALCHEMY_LOCAL=false, staging base
│   ├── stg_1    ← preview slot 1: os.iterate-preview-1.com / iterate-preview-1.app
│   ├── stg_2    ← preview slot 2
│   ├── ...
│   └── stg_10   ← preview slot 10
└── prd          ← os.iterate2.com / iterate2.app
```

### Key env vars per config type

| Var                                 | dev_jonas                          | stg_N                                 | prd                       |
| ----------------------------------- | ---------------------------------- | ------------------------------------- | ------------------------- |
| `APP_CONFIG_BASE_URL`               | `https://os.iterate-dev-jonas.com` | `https://os.iterate-preview-N.com`    | `https://os.iterate2.com` |
| `APP_CONFIG_PROJECT_HOSTNAME_BASES` | `["iterate-dev-jonas.app"]`        | `["iterate-preview-N.app"]`           | `["iterate2.app"]`        |
| `ALCHEMY_LOCAL`                     | `true`                             | `false`                               | `false`                   |
| `ALCHEMY_STAGE`                     | `dev_jonas`                        | (overridden to `preview-N` at deploy) | `prd`                     |

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

Preview environments use a semaphore-controlled pool of 10 slots (`os2-preview-1` through `os2-preview-10`).

### How it works

1. CI acquires a slot from Semaphore (e.g. `os2-preview-3`)
2. `derivePreviewEnvironment` maps slot 3 → alchemy stage `preview-3`, doppler config `stg_3`
3. `stg_3` has `APP_CONFIG_BASE_URL=https://os.iterate-preview-3.com` and `APP_CONFIG_PROJECT_HOSTNAME_BASES=["iterate-preview-3.app"]`
4. `doppler run --config stg_3 -- pnpm alchemy:up` deploys the worker with correct routes
5. PR body is updated with both `publicUrl` and `projectSubdomainUrl`
6. On PR close, the slot is released back to Semaphore and the worker is destroyed

### Cloudflare zones for previews

Each preview slot N uses:

- `iterate-preview-N.com` (dashboard)
- `iterate-preview-N.app` (project subdomains)

These zones must exist in the `cc7f` Cloudflare account.

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
doppler run --project os2 --config stg_3 -- env ALCHEMY_STAGE=preview-3 pnpm alchemy:up

# Hit it
open https://os.iterate-preview-3.com          # dashboard
open https://myproject.iterate-preview-3.app    # project subdomain

# Clean up
doppler run --project os2 --config stg_3 -- env ALCHEMY_STAGE=preview-3 pnpm alchemy:down
```

### Known issue: preview slot 1

`iterate-preview-1.com` is in Cloudflare account `376e...` instead of `cc7f...`. Worker routes for the `.com` domain fail for slot 1. Use slots 2-10 until this zone is moved.

### Adding a new developer

1. Buy/register `iterate-dev-<name>.com` and `iterate-dev-<name>.app` in the `cc7f` account
2. Create doppler config: `doppler configs create dev_<name> --project os2`
3. Set the domain vars:
   ```bash
   doppler secrets set \
     APP_CONFIG_BASE_URL="https://os.iterate-dev-<name>.com" \
     'APP_CONFIG_PROJECT_HOSTNAME_BASES=["iterate-dev-<name>.app"]' \
     --project os2 --config dev_<name>
   ```
4. Run `pnpm dev` — the tunnel and DNS are created automatically on first run
