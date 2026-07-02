---
state: done
priority: high
size: large
tags: [os, mcp, grok, oauth, preview, auth]
updated: 2026-07-02
pr: https://github.com/iterate/iterate/pull/1588
preview: preview_4
---

# OS MCP: Grok connector couldn't list tools (post-mortem)

## Symptom

Grok Voice Builder (user agent `grok-connectors-manager/0.1.0`) could reach the
OS MCP server (`https://mcp.iterate.com/`), fetch protected-resource metadata,
and complete the browser OAuth flow — but then failed to list tools. OS
returned `401`. Reproduced on `preview_4` throughout.

A known-good reference server
(`/Users/jonastemplestein/src/tries/2026-07-02-zero-trust-mcp`) worked in Grok,
which pointed at OS/auth interop rather than Grok itself.

## Root causes (all first-party; Grok was blameless)

Grok sends a genuine Better Auth **opaque** access token (32 chars, not a JWT).
It is opaque — not a JWT — because Grok does not send an RFC 8707 `resource`
parameter, and Better Auth only mints a JWT access token when an audience is
requested (`isJwtAccessToken = audience && !disableJwtPlugin`). OS's verifier
only accepted JWTs, so an opaque fallback (auth-worker introspection) was added
— and that fallback had three bugs:

1. **Raw-value token lookup vs hashed storage.** `@better-auth/oauth-provider`
   stores opaque tokens (and client secrets) as `base64url(sha256(value))`
   unpadded — the raw bearer never appears in `oauthAccessToken.token`. The
   introspection query looked up the raw value, so it always returned
   `not_found`. Confirmed empirically: every stored token value is 43 chars
   (a hash), the presented token is 32 (the raw value).

2. **`sid: null` violated the introspection output contract.** For
   session-less tokens the handler returned `sid: null`, but the oRPC contract
   declares `sid: z.string().optional()` → `Output validation failed`.

3. **Project selection was sticky and global.** `/project-access` stores the
   chosen projects in `oauthProjectSelection`, meant to be consumed once at
   token mint. But `customAccessTokenClaims` (the consume point) never runs for
   opaque tokens — claims are reconstructed at introspection — so the row was
   never deleted. Worse, the lookup matched by **user id** (any client, forever)
   instead of the table's `(session_id, client_id)` key. Result: the first-ever
   project selection silently applied to every future MCP client and the
   selection page never appeared again.

## Fixes (PR #1588)

- `apps/auth` internal introspection hashes the presented bearer with the same
  base64url-sha256 helper used for client secrets before lookup
  (`hashOAuthStoredValue`); maps `sid` null→undefined.
- Project selection lookup is scoped to the auth **session** with a 10-minute
  freshness window (`getFreshOAuthProjectSelectionBySessionId`,
  `resolveStoredProjectSelection({ sessionId })`). A later connection — or any
  new client — re-enters `/project-access`. The dead mint-time delete is gone;
  stale rows are swept when a new selection is stored. Per-client scoping isn't
  possible because Better Auth's `postLogin` hooks don't receive the client id.
- OS MCP handler: opaque-token introspection fallback in `resolveMcpAuth`,
  `x-forwarded-host/proto` propagation through the MCP ingress rewrite so
  resource metadata reflects the public host, and the protected-resource
  metadata/challenge helpers in `mcp-auth-metadata.ts`.

## Proof

`apps/os/e2e/vitest/mcp-oauth.e2e.test.ts` reproduces the entire Grok flow
headlessly against a deployed preview: DCR of a public PKCE client → authorize
(asserts the `/project-access` redirect when no fresh selection exists) → store
selection → continue → consent → token exchange → asserts an **opaque** token
(not a JWT) → MCP `initialize` + `tools/list` returns `exec_js`. Verified green
against `preview_4`. It gates on `SERVICE_AUTH_TOKEN` (the bootstrap-admin
password, an auth-worker secret) and skips cleanly where that is absent, like
the preview smoke's admin-secret gate.

Run it:

```sh
cd apps/os && doppler run --project auth --config preview_4 -- \
  env APP_CONFIG_BASE_URL=https://os.iterate-preview-4.com \
  pnpm e2e -t "project MCP OAuth"
```

## Notes / follow-ups

- Better Auth issues opaque tokens whenever no `resource` is requested. If we
  ever want JWT-only, either require `resource` from clients or reconsider the
  opaque fallback — but the fallback is correct and needed for real clients
  (Grok, generic MCP connectors) that omit `resource`.
- The reverse-bisect server
  (`/Users/jonastemplestein/src/tries/2026-07-02-zero-trust-mcp-preview4-auth`,
  deployed at `zero-trust-mcp-preview4.templestein.workers.dev`) validates
  bearers via the auth `userinfo` endpoint and is handy for isolating
  Grok × Better Auth interop from OS code.
