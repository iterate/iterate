# OAuth deploy review

Reviewer: Claude Fable 5.1, effort xhigh. Exact model verified from CLI model usage. Read-only review; no permission denials.

Review complete. I read the touched modules, their dependencies, the pinned oauth4webapi 3.8.5 build and the provider 0.10.3 source. No files were modified.

## Blockers

**1. Google sign-in 500s for any email the admin fixture already created.** The users table has a unique email column. Google login inserts `user_google_<sub>` with `ON CONFLICT(id)`, so an existing `user_<email>` row with the same email trips the UNIQUE constraint and D1 throws. The catch in `identity.ts:81` only handles oauth4webapi errors, so the visitor gets a 500. The reverse also holds: admin `as` or `POST /login` for an email that already signed in via Google fails. Decide one rule: either link by verified email (adopt the existing row's id) or reserve fixture emails to a test domain on deployed origins and answer the collision with a clear 409.

**2. Console "Log out" does not end the issuer session.** The account page posts to `/.auth/logout`, which ends the browser grant only. The issuer cookie set by the Google callback stays valid for 30 days, so the next person on that browser reaches `/authorize` and can approve the console or any project as the previous user without touching Google. On the platform origin, `/.auth/logout` should also send `clearSessionCookie()`.

**3. Test lanes that hit the new admin gate.** The workers lane origin is `https://control.test`, which is not local, so every `POST /login` fixture now returns 401 unless it carries `Authorization: Bearer <admin secret>`:

- `__workers-tests__/oauth.test.ts` in `grant()` and the browser CIMD test
- `__workers-tests__/control-plane.test.ts` `signIn()` (this file also still uses cookie `authenticate`, project tokens on hosts and `/oauth/register`, all removed)
- `__workers-tests__/session-doors.test.ts:248`
- `specs/live-state-demo.spec.ts:14`, and `specs/auth.spec.ts`, which drives an email textbox the login page no longer renders off localhost
- e2e against a deployed worker: `/internal/rpc` now needs a bearer, but a WebSocket handshake cannot carry one, so `e2e/support/client.ts` breaks for deployed runs only

## Verified correct

- **oauth4webapi 3.8.5 refs.** `processGenericAccessTokenResponse` stores the JWT keyed on the Response and the claims keyed on the returned JSON. Passing `response` to `validateApplicationLevelSignature` and `tokens` to `getValidatedIdTokenClaims` is right. Nonce is required and checked because `expectedNonce` is a string.
- **Error classification.** `?error=` gives `AuthorizationResponseError`, state or nonce mismatch gives `OperationProcessingError`, Google's bad or reused code is `ResponseBodyError` with `invalid_grant`. Client misconfiguration (`invalid_client`, challenge errors) rethrows as 500, which is appropriate.
- **Finite refresh lifetime.** In 0.10.3, `refreshTokenTTL: 0` skips the block that sets `grantData.expiresAt`, so the grant would be saved with no KV expiry. Issuing a refresh token with TTL equal to the access TTL, discarding it, and refusing personal refresh in the callback is correct. The refusal runs before rotation or any write.
- **Cleanup.** Every grant is capped at the 30 day deadline in both the callback and `authorizationOf`, so rows untouched for 31 days are dead. Rows with `cleanup_pending = 1` are kept, as intended.
- **Stamp hygiene.** The edge strips inbound `x-itx-*`, and the DO's egress removes the principal and expression headers before the config worker's outbound fetch, so the Notes proxy leaks no principal to `notes.iterate2.com`. The Notes worker holds no authority.
- **Audience.** An MCP root audience matches only the MCP origin, and an API audience is path bound, so a token for one cannot reach the other.

## Inconsistencies to settle

- `worker.ts:150` refuses any bearer that is not a platform token, while the `projectHostRequestTo` comment and the old tests describe pass-through of an app's own bearer. With refusal, `platformBearer` is always true when a bearer is present. Pick one and delete the other.
- Anyone with a verified Google account can sign in and create projects. Fine if intended; there is no `hd` or allowlist check.

## Simplifications

- Auto-approve the console's own first-party client id at `/authorize` with `projects: null`. It removes the consent click for the console itself and nothing else changes.
- Replace the hand-rolled PKCE and state in `authorizationCodeRequest` with the oauth4webapi generators now that the dependency exists.
- Move `isLocalOrigin` into `lib.ts` and reuse it in `browser-session.ts`, which reimplements the same test inline.
- Google discovery is fetched twice per login with no cache. A module-level memo or the three fixed endpoints removes two network calls.
- `mintPersonalToken` spreads `env` to inject helpers, which defeats the config memo. Let `parseAuthorization` take the helpers directly.
- `parseAppConfig` should refuse a half-configured Google pair the way it refuses other malformed vars, instead of a runtime 503.
