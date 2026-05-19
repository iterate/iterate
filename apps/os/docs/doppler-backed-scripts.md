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

Do not put `--project os` or `--config prd` in the default script. That makes
plain local commands surprisingly target production and bypasses the user's
local Doppler setup.

## App Config Defaults

Shared tools should prefer app config env vars when they exist. For deployed
apps, Doppler already provides `APP_CONFIG_BASE_URL` and auth secrets such as
`APP_CONFIG_ADMIN_API_SECRET`; scripts should not re-map those in every app.

App-prefixed override variables like `OS_BASE_URL` and `OS_API_TOKEN` are still
useful for ad hoc local overrides, but they should not be required for normal
`doppler run --config <config> -- pnpm cli ...` usage.
