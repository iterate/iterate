# Operator Sessions

Operator sessions let a person who holds an environment's
`APP_CONFIG_ADMIN_API_SECRET` administer that exact OS deployment without
putting the platform secret in a browser, URL, cookie, or project runtime.

Use a **project session** for support and debugging. It behaves like a user
whose claims contain exactly the selected project. Use an **admin session**
only for deployment-wide tools under `/admin`.

## Browser

Run from `apps/os`. Doppler selects both the target URL and the matching admin
secret, so changing `--config` changes the complete security boundary.

```bash
# Impersonate a project member in production and open the project dashboard.
doppler run --config prd -- pnpm cli session create \
  --project my-project \
  --as support@nustom.com \
  --open

# Preview slot 3, printing the one-shot URL for another browser or Playwright.
doppler run --config preview_3 -- pnpm cli session create \
  --project my-project \
  --as support@nustom.com

# Explicit platform-wide administration. Defaults to /admin and 15 minutes.
doppler run --config prd -- pnpm cli session create --admin --open
```

`--project` accepts a slug or `prj_` id. Project sessions require `--as` so
audit events identify who the operator chose to act as. `--ttl-seconds` may be
60 through 3600; the default is 900. `--return-to` must be a same-origin
absolute path.

The printed URL carries the signed grant after `#`, so the grant is not sent
in the HTTP request, edge request URL, referrer, or browser history entry. A
small same-origin redemption page removes the fragment, verifies the grant,
and installs an HttpOnly, host-only, `SameSite=Strict` cookie. Treat the URL as
a bearer capability until it expires and open it promptly.

## CLI And API

The normal CLI already uses `APP_CONFIG_ADMIN_API_SECRET` directly. To execute
with one project's user authority instead of platform authority, add `--as`
and a project id:

```bash
doppler run --config prd -- pnpm cli itx run \
  --context prj_123 \
  --as support@nustom.com \
  --eval 'return await itx.projects.list()'

doppler run --config preview_3 -- pnpm cli itx start-repl \
  --context prj_123 \
  --as support@nustom.com
```

Automation can also call `POST /api/operator-sessions` with
`Authorization: Bearer <APP_CONFIG_ADMIN_API_SECRET>` and an
`application/json` body:

```json
{
  "kind": "project",
  "project": "my-project",
  "subject": "support@nustom.com",
  "ttlSeconds": 900
}
```

The response includes the browser URL and a signed `token`. Non-browser RPC
clients may authenticate with
`{ type: "operator-session", token }`; unlike ambient cookie auth, this is an
explicit credential and can be used by controlled cross-origin test pages.

## Security Properties

- The admin secret is accepted only as a bearer credential on the issuance
  request. The old browser secret-paste endpoint and raw-secret cookie no
  longer exist.
- Grants are HMAC-SHA256 signed, versioned, bound to the exact deployment
  origin, and limited to one hour. Rotating the admin secret revokes every
  outstanding grant and cookie.
- Project references are resolved by the deployment before signing. A project
  grant contains exactly one project id and cannot list or open another. Its
  claims are not widened through the ordinary user-membership refresh path.
- Platform authority is a distinct, explicit grant kind. It is never inferred
  from a missing project.
- Cookie-authenticated RPC rejects a browser `Origin` that does not exactly
  match the OS origin. This covers both operator and normal Iterate cookies.
- Issuance and redemption emit metadata-only audit events containing the
  subject, kind, session id, expiry, and optional project id. Neither the admin
  secret nor signed grant is logged.
- The redemption response is `no-store`, frame-denied, protected by a strict
  CSP, and redirects only to the path signed into the grant.

Operator grants are stateless bearer capabilities and are not individually
revocable before expiry. Use the short default TTL; rotate the environment's
admin secret when immediate global revocation is required.

`pnpm auth:mint` is different: it forges a complete Iterate OAuth identity for
development and auth-flow testing and requires `AUTH_FORGE_PRIVATE_JWK`.
Operator sessions need only the environment's admin secret and are the
preferred mechanism for support and deployment administration.
