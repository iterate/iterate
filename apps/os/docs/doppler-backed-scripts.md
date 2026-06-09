# Doppler-Backed Scripts

Some package scripts need app secrets and app config, but the script itself
should not decide which environment to target. That choice belongs to Doppler.

## Pattern

Keep `package.json` simple:

```json
{
  "scripts": {
    "cli": "tsx ./scripts/cli.ts"
  }
}
```

Put the environment bootstrap in a small, documented TypeScript script:

- If `DOPPLER_CONFIG` is already set, run the tool directly.
- If not, run `doppler run -- ...` with no `--project` and no `--config`.
- Let local `doppler setup` choose the default project/config.
- Let explicit wrappers choose production or preview.

## Usage

From an app directory that has Doppler setup:

```bash
pnpm cli rpc --help
```

Target a specific config explicitly:

```bash
doppler run --config prd -- pnpm cli rpc --help
doppler run --config preview_3 -- pnpm cli rpc --help
```

Local operational commands should also live under `pnpm cli`, not as
environment-pinning package scripts. For example, the Iterate config base
Artifact repair command runs through the local script router:

```bash
pnpm cli artifacts seed-config-base
doppler run --project os --config dev_jonas -- pnpm cli artifacts seed-config-base
```

Do not put `--project os` or `--config prd` in the default script. That makes
plain local commands surprisingly target production and bypasses the user's
local Doppler setup.

## App Config Defaults

Shared tools should prefer app config env vars when they exist. For deployed
apps, Doppler already provides `APP_CONFIG_BASE_URL` and auth secrets such as
`APP_CONFIG_ADMIN_API_SECRET`; scripts should not re-map those in every app.

Use `APP_CONFIG_BASE_URL` for both configured deployments and ad hoc local
overrides. When wrapping a local override with `doppler run`, pass
`--preserve-env=APP_CONFIG_BASE_URL` so Doppler does not replace it with the
configured deployment URL.
