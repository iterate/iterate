# Registry Service

The registry service tracks service routes and acts as the system bridge to Caddy.

Caddy is the first point of contact for all ingress into a deployment. `getPublicURL` is the
single procedure responsible for turning an internal URL into a public URL.

## `getPublicURL`

Procedure: `registry.getPublicURL`

Input:

- `internalURL: string`

Output:

- `publicURL: string`

Environment variables used:

- `ITERATE_PUBLIC_BASE_URL`
- `ITERATE_PUBLIC_BASE_URL_TYPE` (`prefix` or `subdomain`, default `prefix`)
