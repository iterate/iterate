# Doppler setup for a new app

Use the [canonical environment model](../../../../docs/devops-cloudflare-doppler.md), `envs.ts` and `doppler.yaml` as the source of truth. Inspect a comparable current app before provisioning.

- Give an independently deployable app its own Doppler project. Add only its `project` and `path` to root `doppler.yaml`; do not pin a config there.
- Inherit credentials from `_shared.dev`, `_shared.preview` or `_shared.prd` as appropriate. Do not override Cloudflare account IDs or tokens in app/branch configs.
- Create the local, named developer and leased preview configs required by the actual environment definitions. Do not invent preview slots or copy a historical list of people.
- Disable Doppler's automatic Personal Configs for the Development environment; the repo uses named configs. This requires environment settings in the dashboard or the environment API, not a secret named `DOPPLER_CONFIG`.
- Set only secrets the app's current schema needs. Deployment hostnames and other non-secret environment configuration come from `envs.ts`; do not copy old `APP_CONFIG_BASE_URL` or `APP_CONFIG={}` recipes blindly.
- Confirm the selected project/config and inherited secret names without printing secret values. Existing Doppler values follow the authorization rule in the canonical guide.

Use `doppler projects create`, `doppler configs create/update`, and `doppler setup` with the selected project/config. Consult current command help for arguments and [Doppler's Personal Configs documentation](https://docs.doppler.com/docs/branch-configs) for the environment setting.
