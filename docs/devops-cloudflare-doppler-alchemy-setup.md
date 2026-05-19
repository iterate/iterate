# DevOps: Cloudflare, Doppler, And Alchemy

This repo deploys Cloudflare apps by choosing a Doppler config and running the
same Alchemy entrypoint. The config supplies secrets, app config, deployment
config, and Cloudflare credentials; the script should not decide which
environment it is targeting by branching on hard-coded names.

## Core Model

- Every independently deployable app has a Doppler project: `os`, `events`,
  `semaphore`, `example`, `iterate-com`, etc.
- The repo uses Doppler's monorepo setup in `doppler.yaml`; the current working
  directory chooses the project unless a command explicitly passes `--project`.
- The Doppler config chooses the environment. Typical configs are `dev_<user>`,
  `preview_N`, and `prd`.
- `_shared` owns values that are inherited by apps, including Cloudflare account
  credentials and `ALCHEMY_STAGE=${DOPPLER_CONFIG}`.
- Do not use Doppler `dev_personal` configs. Turn them off whenever you see
  them; use named shared configs such as `dev_jonas`.

Confirm with a human before changing existing Doppler values. Changing Doppler
changes deployed behavior without a git diff.

## Doppler Placement Rules

Put values in the highest config that is correct:

- If every app/config in an environment needs it, put it in `_shared/dev`,
  `_shared/preview`, or `_shared/prd`.
- If only preview configs need it, put it in `_shared/preview`, not each
  `preview_N`.
- If only one app needs it, put it in that app's project.
- If only one branch config needs it, put it in that branch config.
- Never override `CLOUDFLARE_ACCOUNT_ID` or `CLOUDFLARE_API_TOKEN` in app
  configs or branch configs.

There should be exactly three inherited Cloudflare credential sets:

- `_shared/dev`
- `_shared/preview`
- `_shared/prd`

## App Config And Deployment Config

App Config is runtime config. It is parsed as a strongly typed JavaScript object
from env vars prefixed with `APP_CONFIG_`, then serialized into the deployed
runtime and read by app code.

Deployment Config is deployment-time config. Alchemy reads it while declaring
Cloudflare resources, but it should not be serialized into the running app.

Keep this boundary strict. A deployment script may need a privileged Cloudflare
API token to create routes, D1 databases, R2 buckets, tunnels, or Worker
bindings. The deployed Worker usually does not need that token at runtime.

Examples:

- `APP_CONFIG_BASE_URL` is App Config.
- `APP_CONFIG_PROJECT_HOSTNAME_BASES` is App Config.
- `CLOUDFLARE_ACCOUNT_ID` is Deployment Config.
- `CLOUDFLARE_API_TOKEN` is Deployment Config.
- `DEPLOYMENT_CONFIG_STREAM_DURABLE_OBJECT_BINDING_SCRIPT_NAME` is Deployment
  Config.

## Cloudflare Accounts

Cloudflare credentials come from Doppler:

- `iterate (prd)` is the production Cloudflare account. Use it only through
  `prd` configs.
- `dev/preview` is the shared non-production account. Use it for all local
  development and preview deployments.
- Other accounts may appear in tooling, especially the Cloudflare MCP server.
  For example, `garple` is a pretend customer account. Personal Cloudflare
  accounts should only be used when specifically requested.

Current account split:

| Doppler config family | Cloudflare account | Account ID prefix |
| --------------------- | ------------------ | ----------------- |
| `_shared/dev`         | dev/preview        | `376ef7ed...`     |
| `_shared/preview`     | dev/preview        | `376ef7ed...`     |
| `_shared/prd`         | iterate (prd)      | `04b3b572...`     |

Use a user-level Cloudflare token for zone operations. Account-level tokens do
not work for zone-level DNS operations.

## Alchemy

Deployments use Alchemy v1. For new-style Cloudflare apps, do not pass a stage
separately. Select the Doppler config and let `_shared` provide
`ALCHEMY_STAGE=${DOPPLER_CONFIG}`.

Run the app's `alchemy.run.ts` through Doppler:

```bash
cd apps/os
doppler run --project os --config dev_jonas -- pnpm exec tsx ./alchemy.run.ts
doppler run --project os --config preview_2 -- pnpm exec tsx ./alchemy.run.ts
doppler run --project os --config prd -- pnpm exec tsx ./alchemy.run.ts
```

The same primitive starts local dev, deploys a preview, or deploys production
depending on the config. Destroy uses the same config:

```bash
doppler run --project os --config preview_2 -- pnpm exec tsx ./alchemy.run.ts --destroy
```

## Local Development

Use `pnpm dev` for normal local OS development. It wraps Doppler and Alchemy.

```bash
pnpm install
pnpm dev
```

For an explicit app/config:

```bash
cd apps/os
doppler run --project os --config dev_jonas -- pnpm exec tsx ./alchemy.run.ts
```

OS dev configs usually mirror production with two hostnames:

| Role               | Pattern                            | Example                      |
| ------------------ | ---------------------------------- | ---------------------------- |
| Dashboard          | `os.iterate-dev-<user>.com`        | `os.iterate-dev-jonas.com`   |
| Project subdomains | `<project>.iterate-dev-<user>.app` | `demo.iterate-dev-jonas.app` |

When `APP_CONFIG_BASE_URL` points at a real hostname, Alchemy creates the
Cloudflare Tunnel, DNS records, and local `cloudflared` process. If
`APP_CONFIG_BASE_URL` is absent or localhost-oriented, Vite runs locally without
a tunnel.

## Environment Configs

An environment config is the Doppler config selected for a run. Multiple apps
can deploy into the same environment config; for example a PR preview can deploy
`os`, `events`, and `semaphore` with the same `preview_N` config.

| Config      | Typical effect                                                 |
| ----------- | -------------------------------------------------------------- |
| `dev_<you>` | Local dev server and tunnel (`ALCHEMY_LOCAL=true`)             |
| `preview_N` | Deploy to `os.iterate-preview-N.com` and preview project hosts |
| `prd`       | Deploy to `os.iterate.com` and `*.iterate.app`                 |

For OS, domain identity comes from App Config:

- `APP_CONFIG_BASE_URL`: canonical dashboard URL, such as
  `https://os.iterate.com`.
- `APP_CONFIG_PROJECT_HOSTNAME_BASES`: project host bases, such as
  `["iterate.app"]`.

Alchemy derives Worker routes from those values. Do not add a separate
`WORKER_ROUTES` env var for OS route computation.

## Preview Environments

PR previews use Semaphore environment config leases. A lease points to one
Doppler config, such as `preview_2`; every selected app deploys with that same
config.

Preview source of truth:

- Semaphore production database stores the available preview leases.
- The managed PR body section stores the lease and per-app deployment results.
- Doppler stores each app project's values for the leased config.
- There is no separate app-specific preview resource inventory.

Current preview slots are `preview_1` through `preview_9`. Each slot needs two
Cloudflare zones in the dev/preview account:

- `iterate-preview-N.com` for dashboard hosts such as
  `os.iterate-preview-N.com`.
- `iterate-preview-N.app` for project/MCP hosts such as
  `<project>.iterate-preview-N.app`.

Use the repo preview CLI for PRs so Semaphore owns the lease:

```bash
doppler run --project _shared --config prd -- pnpm preview status
doppler run --project _shared --config prd -- pnpm preview reconcile
GITHUB_TOKEN="$(gh auth token)" doppler run --project _shared --config prd --preserve-env=GITHUB_TOKEN -- pnpm preview sync --pull-request-number 1234
GITHUB_TOKEN="$(gh auth token)" doppler run --project _shared --config prd --preserve-env=GITHUB_TOKEN -- pnpm preview cleanup --pull-request-number 1234
```

Direct app deploys to `preview_N` are useful for debugging the primitive, but
they bypass Semaphore and can collide with a PR that owns the same lease.

## Production Deployments

Production deploys use each app's `prd` config. Generated per-app GitHub
workflows deploy production from `main`; manual deploys should still use the
same Doppler config and Alchemy entrypoint.

```bash
cd apps/os
doppler run --project os --config prd -- pnpm exec tsx ./alchemy.run.ts
```

## OS Hostnames

OS routing has two layers:

1. Cloudflare Worker routes decide which Worker script receives a request.
2. OS ingress decides what that Worker does with the host.

`apps/os/alchemy.run.ts` manages routes derived from App Config:

- `APP_CONFIG_BASE_URL` -> dashboard host, such as `os.iterate.com`.
- `APP_CONFIG_PROJECT_HOSTNAME_BASES` -> project host base and wildcard, such
  as `iterate.app` and `*.iterate.app`.

Alchemy does not manage the `iterate.com` apex custom-hostname route. Do not add
`iterate.com` to `APP_CONFIG_PROJECT_HOSTNAME_BASES`; that would make ordinary
deploys fight the shared `iterate.com` zone.

Production manual routes on `iterate.com`:

| Pattern             | Worker            | Notes                                        |
| ------------------- | ----------------- | -------------------------------------------- |
| `iterate.com/*`     | `os-prd`          | Apex website served by the `iterate` project |
| `*.iterate.com/*`   | `os-prd`          | Single-label project app subdomains          |
| `os.iterate.com/*`  | `os-prd`          | OS dashboard, Alchemy-managed                |
| `www.iterate.com/*` | `iterate-website` | Marketing site                               |

Set `custom_hostname = iterate.com` on the `iterate` OS project to serve the
apex through OS. Custom hostnames are project data, not
`APP_CONFIG_PROJECT_HOSTNAME_BASES`.

To mirror this on preview slot `N`, add manual routes on
`iterate-preview-N.com`:

- `iterate-preview-N.com/*` -> `os-preview-N`
- `*.iterate-preview-N.com/*` -> `os-preview-N`

Then set the preview `iterate` project custom hostname to
`iterate-preview-N.com`.

## Cloudflare Tools

Use the tool that matches the job:

- New Cloudflare CLI: preferred for direct Cloudflare operations. Run it through
  Doppler, for example `doppler run --project os --config prd -- cf ...`.
- Cloudflare MCP server: useful for coding agents when access is available.
- `wrangler`: use where it is still required, such as SSH into a running
  Cloudflare container.
- Raw API: acceptable for precise audits and cleanup; always run through a
  Doppler config so credentials come from the correct account.
