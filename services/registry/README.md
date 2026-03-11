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

## Public URL resolution

Procedure: `registry.getPublicURL`

Input: `internalURL: string`
Output: `publicURL: string`

Environment variables:

- `ITERATE_INGRESS_HOST`
- `ITERATE_INGRESS_ROUTING_TYPE` (`dunder-prefix` or `subdomain-host`, default `subdomain-host`)
- `ITERATE_INGRESS_DEFAULT_SERVICE` (default `home`)
