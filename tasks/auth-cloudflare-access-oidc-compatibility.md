---
state: todo
priority: medium
size: medium
tags: [auth, cloudflare, zero-trust, oidc, access]
---

# Make iterate auth work with Cloudflare Access (OIDC IdP)

Enable `auth.iterate.com` (and env-equivalent auth workers) to be used as a
**generic OIDC identity provider** for [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/).
Today that integration is blocked by token signing algorithm mismatch.

## Why this exists

We put personal / internal tools (e.g. herdr-remote on a Cloudflare Tunnel)
behind Cloudflare Access on the **iterate (dev/preview)** Zero Trust org
(`iterate-dev-preview.cloudflareaccess.com`). Access currently uses
**one-time PIN email**, which is unreliable (PIN mail from
`noreply@notify.cloudflare.com` often never arrives; nustom/Gmail gateways
quarantine it).

The preferred long-term gate is **“log in with iterate”** — same Google /
email-OTP identity users already have at `auth.iterate.com` — instead of a
second Google OAuth client or Cloudflare OTP.

Related short-term workaround (not this task): Google Workspace as the Access
IdP + Access policy `email_domain: nustom.com`.

## Current auth OIDC surface (verified 2026-07-13)

Production discovery:

```text
GET https://auth.iterate.com/api/auth/.well-known/openid-configuration
```

| Field                                   | Value                                                     |
| --------------------------------------- | --------------------------------------------------------- |
| `issuer`                                | `https://auth.iterate.com/api/auth`                       |
| `authorization_endpoint`                | `…/oauth2/authorize`                                      |
| `token_endpoint`                        | `…/oauth2/token`                                          |
| `jwks_uri`                              | `…/jwks`                                                  |
| `userinfo_endpoint`                     | `…/oauth2/userinfo`                                       |
| `scopes_supported`                      | `openid`, `profile`, `email`, `offline_access`, `project` |
| `id_token_signing_alg_values_supported` | **`["EdDSA"]` only**                                      |
| JWKS keys                               | `kty: OKP`, `crv: Ed25519`, `alg: EdDSA`                  |

Auth is a real OIDC provider (better-auth `oauthProvider` plugin). Relying
parties already use `@iterate-com/auth/server` against this issuer. Declarative
OAuth clients are seeded from Doppler `AUTH_SEED_OAUTH_CLIENTS` via
`apps/auth/scripts/seed-oauth-clients.ts` after each deploy (or standalone
`pnpm seed-oauth-clients`).

## The blocker: Cloudflare Access does not accept EdDSA ID tokens

Cloudflare Access **generic OIDC** IdP verifies ID tokens with only:

- RS256, RS512, PS512
- ES256, ES384, ES512

Documented: [Generic OIDC – supported algorithms](https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/generic-oidc/#supported-algorithms-for-generic-oidc-tokens).

**EdDSA / Ed25519 is not listed.** Connecting Access to
`https://auth.iterate.com/api/auth` will fail at ID-token verification until
auth can issue a supported algorithm (at least for Access-shaped clients, or
globally dual-signed).

This is the entire gate for “use iterate auth with Cloudflare Access.”
Everything below assumes that is fixed first.

## Target integration (once signing is compatible)

### 1. Auth: dual-sign or RS256 for OIDC ID tokens

In `apps/auth` (better-auth / oauth-provider path):

- Prefer **dual-signing** (keep EdDSA for existing RPs; also emit RS256 or
  ES256) _or_ advertise multiple algs and let the client negotiate if the
  stack supports it.
- Minimum viable: **add RS256** (or ES256) so Cloudflare’s verifier accepts
  the ID token.
- Update discovery `id_token_signing_alg_values_supported` and JWKS
  accordingly.
- Regression-test existing OS / CLI / MCP relying parties still verify tokens
  (EdDSA path must stay green).

Relevant areas (starting points, not exhaustive):

- `apps/auth/src/server/auth-plugins.ts` — oauth provider plugin config
- `apps/auth/src/server/oauth-metadata.ts` — discovery / metadata
- `apps/auth/src/lib/server.ts` — RP JWT verification (already falls back to
  remote JWKS)
- better-auth / `@better-auth/oauth-provider` key material and `alg` selection

### 2. Auth: seed an OAuth client for Cloudflare Access

Register a confidential (or public+PKCE, if Access requires) OAuth client via
the existing seed path:

- Doppler: `AUTH_SEED_OAUTH_CLIENTS` on **prd** (and preview/dev if useful)
- Redirect URI (must match the Zero Trust team auth domain exactly):

```text
https://iterate-dev-preview.cloudflareaccess.com/cdn-cgi/access/callback
```

If/when Access is also enabled on the **prd** Cloudflare account, add that
account’s callback host too (pattern:
`https://<team-name>.cloudflareaccess.com/cdn-cgi/access/callback`).

Scopes Access needs at minimum: `openid email profile` (map to our supported
scopes). Confirm `email` is present on the ID token and/or userinfo (Access
uses an email claim for policies; we already support `email` in RP code paths).

Optional later: expose iterate custom claims
(`https://iterate.com/claims/is_admin`, org membership, etc.) as OIDC claims
Access can reference — not required for a first cut that only does
“any authenticated iterate user” or email-domain allowlists.

Client create/seed references:

- `apps/auth/scripts/seed-oauth-clients.ts`
- Admin UI: `/admin/clients` on the auth app
- `internal.oauth.setClient` (service-token) used by the seed script

### 3. Cloudflare Access: generic OIDC IdP

On the iterate **dev/preview** account (Access org already created 2026-07-13
as **Iterate Dev/Preview**, auth domain
`iterate-dev-preview.cloudflareaccess.com`):

| Access field       | Value                                                     |
| ------------------ | --------------------------------------------------------- |
| Type               | `oidc` (OpenID Connect)                                   |
| Auth URL           | `https://auth.iterate.com/api/auth/oauth2/authorize`      |
| Token URL          | `https://auth.iterate.com/api/auth/oauth2/token`          |
| Certs / JWKS URL   | `https://auth.iterate.com/api/auth/jwks`                  |
| Client ID / secret | from seeded client                                        |
| Scopes             | `openid email profile`                                    |
| Email claim        | `email` (or whatever we document after dual-sign work)    |
| PKCE               | enable if client supports and Access is configured for it |

API shape (for automation once client credentials exist):

```http
POST /accounts/{account_id}/access/identity_providers
{
  "name": "Iterate Auth",
  "type": "oidc",
  "config": {
    "client_id": "<seeded>",
    "client_secret": "<seeded>",
    "auth_url": "https://auth.iterate.com/api/auth/oauth2/authorize",
    "token_url": "https://auth.iterate.com/api/auth/oauth2/token",
    "certs_url": "https://auth.iterate.com/api/auth/jwks",
    "pkce_enabled": true,
    "email_claim_name": "email",
    "scopes": ["openid", "email", "profile"]
  }
}
```

### 4. Cloudflare Access: application policy

Example app already standing for herdr-remote (personal tunnel):

- Hostname: `herdr.iterate-dev-jonas.app` (CNAME → named tunnel
  `jonas-herdr-remote` on account `376ef7ed81b0573f93524de763666c15`)
- Access app name: `Herdr Remote (Jonas)`
- Today: One-time PIN IdP only; policy includes `email_domain: nustom.com`
  plus individual emails

After iterate OIDC IdP exists:

- Set app `allowed_idps` to the iterate OIDC IdP (optionally keep OTP/Google
  as fallback).
- Policy options:
  - **Anyone who can complete iterate login** → `everyone` after IdP, or
  - **Company only** → `email_domain: nustom.com` (same as Google-Workspace
    approach), or
  - **Custom claim** → once iterate claims are mapped into Access identity.

Access policy model (two layers):

1. **IdP** proves identity (iterate login UI: Google / email OTP).
2. **Policy** decides who is allowed (email, domain, group, OIDC claim).

`email_domain: nustom.com` is valid and intended for “any nustom person.”

### 5. Doppler / secrets

- Do **not** put Access client secrets in the monorepo.
- Seed client id/secret live in Doppler `auth` project configs
  (`AUTH_SEED_OAUTH_CLIENTS` JSON array entries).
- Cloudflare Access IdP secret is stored in the CF dashboard / API only
  (or a private ops secret store if we automate IdP upsert).

## Acceptance criteria

1. Discovery advertises at least one Cloudflare-supported
   `id_token_signing_alg` (RS256 or ES256 family), and JWKS includes a
   matching key.
2. A seeded OAuth client exists on **prd** auth with the Access callback
   redirect URI above.
3. Cloudflare Access can complete a full login against that client (Test IdP
   in Zero Trust dashboard succeeds; ID token verifies).
4. An Access application protected hostname can use policy
   `email_domain: nustom.com` (or equivalent) with the iterate IdP.
5. Existing iterate RPs (OS dashboard, CLI, MCP) still authenticate; no
   production break from dual-sign / key rotation.
6. Short runbook in `apps/auth/docs/` (or README section) describing:
   how to add Access as a client, required redirect URI pattern, and known
   CF algorithm constraints.

## Non-goals

- Replacing OS’s native OIDC login path (OS already talks to auth directly).
- Enabling Access in front of `os.iterate.com` / `auth.iterate.com` themselves.
- SCIM / group sync from iterate into Access (nice-to-have later via custom
  claims).
- Fixing Cloudflare OTP deliverability (separate product limitation).

## Research notes / gotchas (2026-07-13)

- **Account:** iterate shared **dev/preview** CF account
  (`PREVIEW_AND_DEV_ACCOUNT_ID` / `376ef7ed…`). Zero Trust was **not**
  enabled until this experiment; org name `Iterate Dev/Preview`,
  `deny_unmatched_requests: false` so public preview hostnames stay open.
- **Doppler `CLOUDFLARE_API_TOKEN` on `_shared/preview`:** can manage tunnels
  and DNS; **cannot** manage Access APIs (auth error). Access was configured
  via broader Cloudflare MCP credentials. Any automation for Access needs a
  token with Access: Apps/IdP write permissions.
- **EdDSA is intentional** for compact keys in Workers; dual-sign is
  preferred over dropping EdDSA for Access alone.
- **PKCE:** discovery lists `S256`; prefer PKCE-enabled Access OIDC config if
  the seeded client allows public/PKCE flows.
- **Userinfo vs ID token:** confirm `email` lands in the ID token Access
  validates (not only userinfo). If only userinfo has email, configure
  Access email claim path accordingly or add `email` to the ID token.
- **OTP failure mode observed:** Access login UI works; PIN email never
  arrives for `jonas@nustom.com`. Do not rely on CF OTP for internal tools.

## Suggested implementation order

1. Spike dual-sign / RS256 on a preview auth slot; prove Access Test IdP green.
2. Tests for discovery + token alg + existing RP verification.
3. Seed prd OAuth client for Access callback; document secret handling.
4. Register OIDC IdP + point a pilot Access app (e.g. herdr-remote) at it.
5. Runbook under `apps/auth/docs/`.

## References

- Auth app overview: `apps/auth/README.md`
- OAuth client seeding: `apps/auth/scripts/seed-oauth-clients.ts`
- CF Access generic OIDC:
  https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/generic-oidc/
- CF Access callback pattern:
  `https://<team-name>.cloudflareaccess.com/cdn-cgi/access/callback`
- Pilot public hostname (personal tunnel, not production product):
  `https://herdr.iterate-dev-jonas.app`
