# Registry Service

Registry owns service route records and renders Caddy config from that state.

## Caddy integration

- Root file: `~/.iterate/caddy/Caddyfile`
- Managed fragments: `~/.iterate/caddy/*.caddy`
- On any route change, registry:

1. rewrites managed fragment files
2. removes stale managed fragments
3. runs `caddy validate --config <root> --adapter caddyfile`
4. runs `caddy reload --config <root> --adapter caddyfile`

`persist_config off` is expected in the root Caddyfile, so runtime state stays fully file-driven.

Environment variables:

- `CADDY_CONFIG_DIR` (default `/home/iterate/.iterate/caddy`)
- `CADDY_ROOT_CADDYFILE` (default `/home/iterate/.iterate/caddy/Caddyfile`)
- `CADDY_BIN_PATH` (default `/usr/local/bin/caddy`)

## Public URL resolution

Procedure: `registry.getPublicURL`

Input: `internalURL: string`
Output: `publicURL: string`

Environment variables:

- `ITERATE_PUBLIC_BASE_HOST`
- `ITERATE_PUBLIC_BASE_HOST_TYPE` (`prefix` or `subdomain`, default `prefix`)
