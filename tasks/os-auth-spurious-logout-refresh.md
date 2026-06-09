---
state: todo
priority: medium
size: medium
---

# Spurious logouts in OS dev — suspect token refresh

Jonas regularly gets logged out of OS in dev. Access tokens expire after
5 minutes (`accessTokenExpiresIn: 5 * 60` in
`apps/auth/src/server/auth-plugins.ts`), so the refresh path in
`apps/auth/src/lib/server.ts` (`authenticate()` → `doRefresh()`) runs on any
request arriving more than ~4.5 minutes after the last refresh.

## Leading hypotheses

1. **Concurrent-refresh race**: a page load fires several parallel requests,
   each sees the expired token and calls the token endpoint with the same
   refresh token. If refresh tokens are single-use (rotation), only one wins;
   the losers fail and `authenticate()` returns `session: null` → user appears
   logged out, even though the winner's Set-Cookie may have stored a fresh
   token set.
2. **Failure handling too aggressive**: any refresh error — including transient
   network failures — drops the session (`catch { return { session: null } }`)
   instead of retrying or accepting the still-valid-for-30s access token.

## Suggested fixes to evaluate

- Tolerate refresh failure while the current access token is still within its
  validity window (we refresh 30s early via `REFRESH_SKEW_MS`).
- On rotation failure, return the existing session for this request without
  clearing the cookie; the browser will carry the winner's rotated cookie on
  the next request.
- Check whether better-auth's oauth provider rotates refresh tokens on use and
  whether rotated-but-replayed tokens get a grace window.

## Diagnosis still needed

Symptom details weren't pinned down (redirect to /sign-in vs API 401s vs
after-idle vs after dev-server restart). Reproduce before fixing.
