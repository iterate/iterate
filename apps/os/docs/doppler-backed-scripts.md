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

- If the process is already inside `doppler run` (`DOPPLER_CONFIG` is present),
  run the tool directly.
- If not, run `doppler run -- ...` with no `--project` and no `--config`.
- Let local `doppler setup` choose the default project/config.
- Let explicit wrappers choose production or preview.
- Do not set `DOPPLER_CONFIG` by hand; that does not hydrate Doppler secrets.

## Usage

From an app directory that has Doppler setup:

```bash
pnpm cli itx --help
```

Target a specific config explicitly:

```bash
doppler run --config prd -- pnpm cli itx --help
doppler run --config preview_3 -- pnpm cli itx --help
```

Local operational commands should also live under `pnpm cli`, not as
environment-pinning package scripts. For example, running an itx script goes
through the local script router:

```bash
pnpm cli itx run --eval 'return await itx.whoami()'
doppler run --project os --config prd -- pnpm cli itx run --eval 'return await itx.whoami()'
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

## Operator Browser Sessions

Do not put `APP_CONFIG_ADMIN_API_SECRET` in browser code or paste it into the
admin UI. Mint a short-lived project impersonation or explicit platform-admin
session through the Doppler-backed CLI instead:

```bash
doppler run --config dev -- pnpm cli session create \
  --project my-project --as support@nustom.com --open

doppler run --config prd -- pnpm cli session create --admin --open
```

The mechanism and threat model are documented in
[Operator Sessions](./operator-sessions.md).
