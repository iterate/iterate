# Auth

Identity provider and the authoritative organization/project directory. Read the [surface and credential map](README.md#the-four-surfaces) before changing authentication or authorization.

- Keep public OIDC, browser sessions, public oRPC and internal Workers RPC credential boundaries separate.
- Only platform OS workers receive the same-account `AUTH` service binding. Project-controlled workers must not receive it.
- Auth mints project IDs; OS consumes this directory rather than maintaining a second authoritative database.
- Use the existing D1/sqlfu schema and migration workflow described in the [README](README.md).

For local startup and deployment targeting, use the root [environment guide](../../docs/dev-environments.md) and [Cloudflare/Doppler guide](../../docs/devops-cloudflare-doppler.md). Test requirements are in [testing](../../docs/testing.md).
