# Browser auth review

Claude Fable 5.1, xhigh, read-only CLI review of the previous slice.

Disposition:

- Fixed issuer configuration is now required. Local harnesses supply their actual origin.
- Invalid bearer credentials are refused at project ingress, so no platform bearer reaches app code. Authorization belongs to the platform on these hosts.
- Removed exchanging/refreshing phases after verifying the provider keeps the presented refresh token valid until a newer token is used. The review's claim that blockConcurrencyWhile is a storage transaction is incorrect; the provider's retry contract is the reason this works.
- Consent GET and POST classify AuthorizationError and CimdFetchError consistently. POST no longer runs the GET preparation first.
- GET login reuses an existing valid session. It must not end it, because a cross-site GET must not log the user out.
- Removed duplicate grant resources. Kept access expiry for the live transport lease. Kept explicit device refreshTokenTTL undefined: omission uses the provider's 30-day default, as source lines 1507 and 2590 prove.
- Unmatched MCP paths no longer reach the console.

The local workerd proof has since verified both browser flows and live revocation.

## Original review

Review complete. Verdict first, then ranked findings, then the layering call.

**Summary.** The layering is sound: edge dispatch in worker.ts, one browser adapter in browser-client.ts, one provider configuration in oauth.ts, protected resources behind api.ts, token lifecycle in one Durable Object. I found one real blocker in the issuer derivation, one correctness gap in bearer stripping, and four simplifications that delete state or duplicate work. The suspicion about anonymous project-host requests checks out as safe.

## Ranked findings

**1. Blocker: issuer and audience follow the request host when the platform origin is unset, and the deployment leaves it unset.**
`oauth.ts:50` falls back to the request origin. On a project host the adapter calls this with the project-host request at `browser-client.ts:52`, so `begin()` builds an authorize URL on the project host, which the app serves, and a resource of the project host's `/api`, which `parseAuthorization` would reject. `authorizationForToken` at `oauth.ts:207` builds the admission URL the same way, so even a valid platform token presented on a project host gets an audience mismatch, and `browser-client.ts:39` then revokes the grant. The deployed vars at `wrangler.jsonc:109-116` set the project hostname base but not the platform origin, so this is live behaviour, not a theoretical one. The platform-origin check at `worker.ts:184` is also skipped when blank, so any hostname becomes the platform.
Fix: make `oauthAddresses` take `AppConfig` only and delete the request fallback. In `parseAppConfig` at `app-config.ts:101`, refuse a blank platform origin whenever a project hostname base is set. Set the var in the deploy config.

**2. A recognized-but-revoked platform token is forwarded to the app.**
`worker.ts:170` computes `platformBearer` as "authorization succeeded". When the provider recognizes the token but `authorizationOf` denies it on the D1 marker or deadline, the header is passed through verbatim. The token is dead, but its shape is `user_<email>:<grantId>:<secret>`, so the app learns the user's email and grant id, and the stated invariant that an app never sees a platform credential fails.
Fix: have the admission handler in `oauth.ts:201-206` set a `recognized` flag as soon as it runs, and return `{ recognized, authorization }`. Strip the header when `recognized` is true.

**3. Simplification: drop the `exchanging` and `refreshing` phases in the session DO.**
`browser-session.ts:139-147` ends the session whenever it finds an interrupted rotation. The provider keeps the previous refresh token valid until a newer one is used, at `oauth-provider.ts:2725-2731` and `2923-2928`, precisely so a client can retry after a lost response. Storage written inside `blockConcurrencyWhile` is either committed with the callback or discarded, so after a crash the DO holds either the old pair or the new pair, and both refresh cleanly. For the code exchange, a lost response means the code is spent, and a retry gets `invalid_grant`, which already ends the session. The intermediate phases add two states, one extra write per refresh, and a forced re-login for no safety gain.
Fix: `StoredSession = Pending | Active | Ended`. In `bearer()`, exchange when within 30 seconds of expiry and end only on a refused exchange.

**4. Simplification: the consent POST parses and looks up the client twice, and the second pass can 500.**
`control-plane.ts:342-351` runs `consentOf` and then `approveConsent`, each doing `parseAuthorization`, `lookupClient` and `projectsForClient`. The server function at `routes/authorize.tsx:25-30` calls `approveConsent` alone. `approveConsent` has no `AuthorizationError` mapping, so a redirectable refusal becomes a 500 on both paths. `consentOf` also lets `CimdFetchError` through as a 500.
Fix: move the error-to-redirect mapping out of `consentOf` into a small helper, apply it in `approveConsent`, and have the POST door call `approveConsent` only. Map `CimdFetchError` to `{ kind: "invalid" }`.

**5. Simplification: `/.auth/login` should end the session it replaces.**
`browser-client.ts:66-83` mints a new DO and overwrites the cookie. If the previous DO was active, its grant stays live for up to 30 days with nothing referencing it. The console's guard at `routes/_auth.tsx:9` sends every failed page load here, so this happens routinely.
Fix: `await sessionFor(env, request)?.end()` before `begin()`.

**6. Simplification: props that duplicate what the provider already enforces.**
`GrantProps.resources` at `oauth.ts:23` is written at consent and never read. The provider stores and enforces audience itself. `AccessGrant.expiresAt` at `oauth.ts:32` and the check at `oauth.ts:104` duplicate the provider's own token expiry check at `oauth-provider.ts:3894`. The `device` branch at `oauth.ts:181-182` spreads `refreshTokenTTL: undefined`, which the provider treats as "no expiry", the same as omitting it.
Fix: delete `resources`, `expiresAt` and the device branch. Keep `scope`, since a token request can downscope to an empty list.

**7. Minor: the MCP origin falls back to the console for unmatched well-known paths.**
`worker.ts:123` hands `consoleHandler` as the default handler on the MCP origin, so `mcp.iterate2.com/.well-known/anything` renders the console.
Fix: pass the `notFound` handler there.

## Verified as correct

- **Anonymous project-host request reaches the app; forged headers never establish identity.** With no bearer and no cookie, `worker.ts:150-153` yields a null authorization. `projectHostRequestTo` at `worker.ts:64-75` deletes every `x-itx-*` header, replaces the cookie header with app cookies, and sets the principal header only when non-null. The DO reads identity solely from that header at `iterate-context-durable-object.ts:832-838` and derives the app label from the expression, not from any inbound header.
- **Per-host binding.** The DO is named by origin plus a random id, stores the origin, and fixes the redirect URI and client id to that origin. The callback checks `state` and `iss` against stored values. `projectsForClient` at `control-plane.ts:202-212` caps a project-host client's grant to that one project.
- **S256 and resource.** `allowPlainPKCE: false` plus the provider's rule that public clients must use PKCE. `parseAuthorization` admits only the two canonical resources, and the DO sends `resource` on both exchange and refresh, so the audience is the platform `/api`. The project-host `/api` proxy rewrites the URL to the platform `/api`, so audience matching holds.
- **Public ingress.** MCP origin limited to root and well-known. `/internal/rpc` refuses anything but the admin secret at `session.ts:166`. Unknown project labels are 421 before any DO is touched.
- **CSRF and races.** Logout and the console doors require a same-origin `Origin`. The browser `/api` path requires an exact `Origin` when a cookie is present. Refresh, end and complete all run under `blockConcurrencyWhile`, so refresh racing logout is serialized. Fresh token keys are never cached at the edge before they exist, so cross-colo KV lag does not cause spurious logouts.

## Layering verdict

This is close to what Kenton would write: one gate, tokens owned by the released provider, an `Authorization` value that carries principal, reach and grant as a single capability, pure host and config parsing, and a DO whose whole job is one grant. `authorizationForToken` building a throwaway provider around a synthetic request is unusual but is the lowest-duplication way to reuse the provider's audience and external-token logic, so I would keep it.

Two things cut against the grain. The request-derived issuer is host-dependent identity in a design whose issuer is fixed, and finding 1 is the consequence. The DO's interruption phases and the duplicated consent parsing are defensive state that the provider's own semantics already cover. Remove those and the remaining code reads as a straight line from cookie to Durable Object to provider gate to resource.
