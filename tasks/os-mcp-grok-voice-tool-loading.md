---
state: todo
priority: high
size: medium
tags: [os, mcp, auth, grok, oauth]
---

# Grok Voice Builder cannot load OS MCP tools after OAuth

Grok Voice Builder reports `couldn't load tools` for the production OS MCP
server after sending the user through OAuth. MCP Inspector can list tools
successfully, so the failure appears to be client/auth compatibility rather
than the MCP tool implementation being generally broken.

The strongest lead is that OS canonicalizes the protected MCP resource to
`https://mcp.iterate.com` even when the client is configured with
`https://os.iterate.com/api/mcp`. Grok may bind its OAuth/token state to the
configured URL and then present no token, or a token OS rejects for audience /
resource mismatch.

## Production evidence

Cloudflare Workers Observability account: `iterate (prd)`
(`04b3b57291ef2626c6a8daa9d47065a7`). Query the `otel` dataset and services
`os-prd` / `os-prd-app`; `workers` plus `$metadata.service == "os"` is the
wrong shape for these request traces.

Fresh Grok reproduction around `2026-07-02T12:44Z`:

- `2026-07-02T12:44:03.569Z`
  - `POST https://mcp.iterate.com/`
  - status `401`
  - UA `grok-connectors-manager/0.1.0`
  - ray `a14dbd5a4b3a319e`
  - trace `d0d0264174ec7bb7000cef175757a4e0`
  - ingress error: `Can't read from request stream after response has been sent.`
- `2026-07-02T12:44:16.000Z`
  - `POST https://os.iterate.com/api/mcp`
  - status `401`
  - UA `grok-connectors-manager/0.1.0`
  - ray `a14dbda7f8cbe5e4`
  - trace `002dd530f5f1175b7203603381a49852`
- `2026-07-02T12:44:16.132Z` / `12:44:16.142Z`
  - `GET .../.well-known/oauth-protected-resource`
  - status `200`
  - UA `grok-connectors-manager/0.1.0`
  - ray `a14dbda8cf04b87a`
- `2026-07-02T12:44:16.796Z`
  - `GET https://os.iterate.com/api/mcp`
  - status `401`
  - UA `Grok`
  - ray `a14dbdace808b296`
- `2026-07-02T12:44:18.192Z` / `12:44:18.236Z`
  - metadata fetches
  - status `200`
  - UA `Grok`
  - ray `a14dbdb5af9cd69d`
- `2026-07-02T12:44:43Z` and `12:44:48Z`
  - more `POST https://os.iterate.com/api/mcp`
  - status `401`
  - UA `grok-connectors-manager/0.1.0`

Earlier report around `2026-07-02T12:31:02Z` showed the same pattern on
`https://mcp.iterate.com/`: unauthenticated MCP POST, `401`, no authenticated
retry. Ray `a14daa45e98f4b11`, ingress trace
`c3546cea1ae6c0d45829ddb22510442b`.

Observed behavior:

- Grok can reach OS.
- Grok can fetch protected-resource metadata.
- Grok never reaches a successful authenticated `initialize` / `tools/list`
  flow in the traces.
- Observability does not expose the `Authorization` header; however the
  response body size is `31`, matching the live body
  `Missing or invalid bearer token`.
- The ingress `Can't read from request stream after response has been sent.`
  error appears after the app has already returned the expected `401`; do not
  treat it as the primary failure without more evidence.

## Live OS response evidence

Unauthenticated POST to `https://os.iterate.com/api/mcp` returns:

```http
HTTP/2 401
content-type: text/plain;charset=UTF-8
www-authenticate: Bearer resource_metadata="https://mcp.iterate.com/.well-known/oauth-protected-resource"
```

Body:

```text
Missing or invalid bearer token
```

Metadata at `https://os.iterate.com/api/mcp/.well-known/oauth-protected-resource`
and `https://mcp.iterate.com/.well-known/oauth-protected-resource` returns:

```json
{
  "resource": "https://mcp.iterate.com",
  "authorization_servers": ["https://auth.iterate.com/api/auth"],
  "scopes_supported": ["openid", "profile", "email", "offline_access", "project"],
  "bearer_methods_supported": ["header"]
}
```

OS does not currently serve these RFC path-specific protected-resource metadata
URLs:

- `https://os.iterate.com/.well-known/oauth-protected-resource/api/mcp`
- `https://mcp.iterate.com/.well-known/oauth-protected-resource/api/mcp`

The auth issuer is pathful: `https://auth.iterate.com/api/auth`. These metadata
URLs return 200 and look spec-compliant:

- `https://auth.iterate.com/.well-known/oauth-authorization-server/api/auth`
- `https://auth.iterate.com/.well-known/openid-configuration/api/auth`
- `https://auth.iterate.com/api/auth/.well-known/openid-configuration`

The root auth-server metadata URL returns 404:

- `https://auth.iterate.com/.well-known/oauth-authorization-server`

A spec-compliant client should handle the pathful issuer, but a more limited
client may not.

## Working comparison server

Reference server:

- source: `/Users/jonastemplestein/src/tries/2026-07-02-zero-trust-mcp`
- deployed MCP URL:
  `https://zero-trust-mcp.templestein.workers.dev/mcp`
- user reports this works flawlessly with Grok Voice Builder.

Key implementation differences:

- It serves protected-resource metadata at root and accepts suffix variants:
  `pathname.startsWith("/.well-known/oauth-protected-resource")`.
- Its protected resource exactly matches the MCP endpoint:
  `https://zero-trust-mcp.templestein.workers.dev/mcp`.
- Its authorization server is same-origin and pathless:
  `https://zero-trust-mcp.templestein.workers.dev`.
- It serves same-origin auth-server metadata at
  `/.well-known/oauth-authorization-server`.
- Its `401` challenge includes OAuth error fields:

  ```http
  WWW-Authenticate: Bearer error="invalid_token", error_description="Missing or invalid access token", resource_metadata="https://zero-trust-mcp.templestein.workers.dev/.well-known/oauth-protected-resource"
  ```

- It returns JSON OAuth errors:

  ```json
  {
    "error": "invalid_token",
    "error_description": "Missing or invalid access token"
  }
  ```

- It does not enforce OAuth resource/audience validation. Access tokens are
  sealed opaque blobs, so it avoids the configured-URL-vs-canonical-resource
  class of failure entirely.
- It uses `@modelcontextprotocol/server@2.0.0-beta.1`. OS uses
  `@modelcontextprotocol/sdk@1.29.0` plus `agents@0.11.0` / `agents/mcp`.

## Relevant spec and xAI notes

MCP authorization spec:

- HTTP transports may use MCP authorization.
- MCP servers must provide OAuth protected-resource metadata that includes at
  least one `authorization_servers` entry.
- Clients must handle `401 Unauthorized` with `WWW-Authenticate` and the
  `resource_metadata` parameter, and must also support well-known metadata
  discovery.
- Servers should include a `scope` parameter in the `WWW-Authenticate`
  challenge to tell clients which scopes to request.
- Clients must include the OAuth `resource` parameter in authorization and
  token requests. That resource identifies the MCP server the token is for.
- MCP requests must send `Authorization: Bearer <access-token>` on every
  request.
- Missing/invalid tokens should be `401`. Authenticated-but-insufficient scope
  should use `403` with `error="insufficient_scope"` and a `scope` hint.

xAI docs:

- Grok Custom MCP Connectors say users enter an MCP server URL, complete auth,
  and Grok discovers exposed tools.
- xAI Remote MCP / Voice Agent docs document an optional `authorization` token
  that is set in the `Authorization` header. They also say only Streaming HTTP
  and SSE transports are supported.
- Voice Agent Builder was announced as beta on `2026-07-01`, one day before
  this incident. Assume rough edges in OAuth/MCP interop are possible.

References:

- https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization
- https://modelcontextprotocol.io/specification/2025-06-18/basic/transports
- https://www.rfc-editor.org/rfc/rfc9728.html
- https://www.rfc-editor.org/rfc/rfc8707.html
- https://docs.x.ai/grok/connectors
- https://docs.x.ai/developers/tools/remote-mcp
- https://docs.x.ai/developers/model-capabilities/audio/voice-agent
- https://x.ai/news/grok-voice-agent-builder

## Likely causes

1. Grok Voice Builder completes browser OAuth but does not forward the bearer
   token to its server-side tool-listing process.
2. Grok mints or stores a token for `https://os.iterate.com/api/mcp`, while OS
   validates against `https://mcp.iterate.com`.
3. Grok does not correctly fall back from missing `scope` in
   `WWW-Authenticate`, despite the spec allowing fallback to
   `scopes_supported`.
4. Grok assumes root/suffix protected-resource metadata paths and does not like
   OS's endpoint-relative `/api/mcp/.well-known/oauth-protected-resource`.
5. Grok mishandles the pathful split authorization server
   `https://auth.iterate.com/api/auth`.

## Proposed implementation

### 1. Add targeted compatibility logging

For Grok user agents only, log enough auth diagnostics to distinguish missing
token from wrong audience or wrong scope. Do not log token values.

Suggested fields:

- request method and URL
- user agent
- auth header present/absent
- auth failure branch:
  - no admin secret
  - no bearer token
  - token decode/verify failed
  - audience mismatch
  - no project grants
  - missing required scope
- decoded JWT metadata when safely available:
  - `iss`
  - `aud`
  - `scope` / `scopes`
  - `exp`

### 2. Make protected-resource metadata more compatible

Serve protected-resource metadata at all relevant paths:

- `https://mcp.iterate.com/.well-known/oauth-protected-resource`
- `https://mcp.iterate.com/.well-known/oauth-protected-resource/api/mcp`
- `https://os.iterate.com/.well-known/oauth-protected-resource`
- `https://os.iterate.com/.well-known/oauth-protected-resource/api/mcp`
- existing endpoint-relative paths may stay for backwards compatibility.

If the request is for `https://os.iterate.com/api/mcp`, either:

- advertise `resource: "https://os.iterate.com/api/mcp"` and accept that as a
  valid OAuth resource audience, or
- reject/redirect/document that `https://mcp.iterate.com` is the only supported
  public MCP URL.

Do not accept arbitrary request-host resources. Whitelist only the configured
canonical MCP base URL and OS app `/api/mcp` URL.

### 3. Make `WWW-Authenticate` more informative

Change the unauthorized challenge from:

```http
Bearer resource_metadata="..."
```

to include error fields and a scope hint, for example:

```http
Bearer error="invalid_token", error_description="Missing or invalid bearer token", resource_metadata="...", scope="openid profile email offline_access project"
```

Scope choice should be verified against the auth worker's grant behavior. At a
minimum the MCP tool path currently needs `profile` plus project access.

### 4. Tighten status codes for authz failures

- Missing/invalid token: `401 invalid_token`.
- Valid token with wrong audience/resource: probably `401 invalid_token`.
- Valid token with missing project/scope: `403 insufficient_scope` with
  `scope` and `resource_metadata` in `WWW-Authenticate`.

### 5. Consider same-origin auth compatibility shim

If Grok still fails after metadata/resource/header fixes, add an MCP-host
well-known authorization-server shim that returns or proxies the auth worker
metadata. This would make `mcp.iterate.com/.well-known/oauth-authorization-server`
work for clients that assume resource-server and auth-server same-origin.

This should be treated as compatibility glue, not the primary spec shape.

## Acceptance criteria

- Grok Voice Builder can OAuth and load OS MCP tools in production.
- MCP Inspector still lists tools against the canonical production MCP URL.
- Unauthenticated MCP requests return a spec-friendly `401` with
  `resource_metadata`, `error`, `error_description`, and `scope`.
- Path-specific protected-resource metadata URLs return JSON, not app 404 HTML.
- Tokens for the intended public MCP URL validate, and logs can distinguish
  missing token, audience mismatch, and insufficient scope.
- Unit tests cover metadata URL generation, accepted resource audiences, and
  auth challenge headers.

## Code pointers

- `apps/os/src/domains/inbound-mcp-server/mcp-handler.ts`
  - auth resolution
  - protected-resource metadata
  - `WWW-Authenticate` challenge
  - MCP handler setup
- `apps/os/src/lib/mcp-base-url.ts`
  - canonical MCP base URL resolution
- `apps/os/src/workers/ingress.ts`
  - `mcp.iterate.com` to `os.iterate.com/api/mcp` rewrite
- `apps/os/src/routes/api.mcp.ts`
  - MCP route entry point
- `apps/os/src/routes/api.$.ts`
  - wildcard forwarding to MCP route for `/api/mcp/*`
- `packages/shared/src/oauth-resource.ts`
  - OAuth resource/audience normalization and variants

## Open questions

- Should `https://os.iterate.com/api/mcp` be a supported public URL, or should
  all clients be forced onto `https://mcp.iterate.com`?
- Does the auth worker issue tokens for all `resource` params OS passes to
  `createIterateAuth`, or only the canonical value?
- Does Grok Voice Builder support split resource/auth servers with a pathful
  issuer, or does it require same-origin/pathless auth discovery in practice?
- Does Grok Voice Builder support OAuth-discovered MCP auth at all, or only a
  static `authorization` token/header for Remote MCP tools?
