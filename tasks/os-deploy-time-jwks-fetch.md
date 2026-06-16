---
state: todo
priority: medium
size: small
---

# Deploy-time JWKS fetch for OS

OS verifies auth JWTs locally using a static JWKS so authenticated page loads
(including cold isolate starts) make no network roundtrips to the auth worker.
Today the JWKS is copied by hand into Doppler (`ITERATE_AUTH_JWKS` in the `os`
project's `prd`/`preview` root configs and personal dev configs). That works
but has a rotation problem: if auth rotates its signing key, every OS env
breaks until someone updates the secrets and redeploys.

## Proposed shape

- In `apps/os/alchemy.run.ts`, fetch `<issuer>/jwks` at deploy time and feed it
  into `APP_CONFIG_ITERATE_AUTH__JWKS` so it stays typesafe via the `AppConfig`
  zod schema (`iterateAuth.jwks`, already defined in `apps/os/src/config.ts`).
- Keep the `ITERATE_AUTH_JWKS` / `APP_CONFIG_ITERATE_AUTH__JWKS` env vars as an
  explicit override.
- Fall back gracefully (no static JWKS → runtime `createRemoteJWKSet`) when the
  fetch fails or when the issuer is a loopback origin that may not be running
  yet (local dev — see `ensureLocalDevOAuthClient`).
- Once landed, delete the hand-set Doppler secrets.

## Notes

- Key rotation in auth then only requires a redeploy of OS, not a Doppler edit
  per config.
- `dev_localhost` points at a local auth server with different signing keys —
  that's why the manual secret was deliberately not set there.
