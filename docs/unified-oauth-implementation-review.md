# Unified OAuth plan: independent cross-check

Historical research/planning record. The implemented design is documented in
[Unified OAuth and the issuer app](unified-oauth-architecture.md); it supersedes
implementation choices and status statements below.

2026-09-10 · Reviewer: **Claude Fable 5.1**, exact model `claude-fable-5-1`,
invoked with `--effort xhigh`. Read-only review completed successfully; no tool
permission denials. One full source review and two focused follow-up reviews were
completed with that model and effort. The [revised implementation plan](unified-oauth-implementation-plan.md)
is authoritative. This review evaluates a design; it is not runtime or hardware proof.

Subsequent planning decision: disable public Dynamic Client Registration and use
CIMD for external clients, retaining internal `createClient()`. This follows the
[MCP 2026-07-28 policy](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization#overview)
and supersedes earlier DCR-fallback wording. It was added after these Fable reviews;
the implementation plan requires compatibility proof with DCR disabled for the
exact supported client versions.

## Disposition

| Finding or suggestion                                                          | Resolution in the revised plan                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Persistent clients acquire DCR expiry through `updateClient()`                 | Accepted. Never update first-party clients on 0.10.3; register exact callbacks, replace registrations when a callback changes.                                                                                                                                                                          |
| `refreshTokenTTL` during refresh causes `invalid_request`                      | Accepted. Omit the entire key on refresh; use explicit undefined only at initial device code exchange. Add a real immediate device refresh test.                                                                                                                                                        |
| Local tokens currently lack an audience                                        | Accepted. Pin the HTTP resource locally, omitting only the explicitly HTTPS-only issuer list.                                                                                                                                                                                                           |
| Importing apps/auth reverses an earlier owner decision                         | Corrected without changing that decision. Keep the clean room's issuer, directory, and login page. The proposed public-login method is the already-planned Google sign-in, with a small relying party; bare email remains a local fixture. No auth.iterate.com dependency or old auth framework import. |
| Simplify console bootstrap                                                     | Accepted. Verified login completes the console's own standard code + S256 PKCE flow in-process via public helpers; remove the temporary identity-session stage.                                                                                                                                         |
| Avoid a second token lookup on every API request                               | Accepted. Stamp trusted grant identity, effective scope, and a conservative live-authorization deadline in access-token props; retain unwrap only for the browser's one-time grant association.                                                                                                         |
| BrowserSession DO and D1 deny marker are justified                             | Retained. They handle cross-isolate refresh and stale-KV/refresh-revocation races; the provider remains the token/grant owner.                                                                                                                                                                          |
| Cache successful D1 authorization for 60 seconds on every path                 | Not adopted for new HTTP requests or token exchanges: that would weaken the plan's immediate denial after marker commit. Only live connections use a bounded lease; fresh admissions read the primary.                                                                                                  |
| Remove reverse browser-session lookup                                          | Accepted. BrowserSession knows its grant and clears itself; no browser_session_name column.                                                                                                                                                                                                             |
| Copy client and creation fields into the activity table                        | Not needed. Those already come from provider grant summaries. A callback-created empty activity row is not proof of completed issuance or use.                                                                                                                                                          |
| App registration must be dynamic and idempotent                                | Accepted. Explicit app_clients table; first authorized visit creates a candidate, SQL picks one mapping, and losing candidates are deleted.                                                                                                                                                             |
| Ownership, 101 handling, and prefix matching                                   | Accepted. Verify user/grant ownership before marker creation; deliberate Origin handling preserves upgrades; reserve the /api prefix.                                                                                                                                                                   |
| Live-capability revocation needs a real transport mechanism                    | Accepted and made concrete. Own the socket, use the existing synchronous onCall hook for activity/lease checks, and guard native dispatch where needed; test held and forwarded capabilities.                                                                                                           |
| Deterministic tests cannot accelerate deployed KV or reproduce its propagation | Accepted. Inspect grant expiry after real exchange; prove marker precedence while valid KV credentials remain; use preview for distributed evidence.                                                                                                                                                    |
| Kit/firmware/tests were under-estimated                                        | Accepted. Browser/device scope: 1,900–3,050 production lines plus 1,300–2,000 test lines. Firmware includes partition/Wi-Fi import, codegen, and release wiring. The later personal/admin-token addition raises the final totals below.                                                                 |
| Revised-plan follow-up found four wording gaps                                 | Accepted. Register the console's exact synthetic callback and persist its client secret; spread grant props into access props; serve the Google callback only at the platform; include the two worker API handlers in estimates.                                                                        |
| Later user requirement: preserve global admin and individual bearer tokens     | Accepted. Admin Bearer remains at the canonical API through the existing verifier/external-token hook; personal tokens are ordinary provider access tokens, each with its own user grant. No second hashed-token store.                                                                                 |
| Personal tokens can skip refresh but their grant metadata will not auto-expire | Accepted. Use `refreshTokenTTL: 0`, a finite access/authorization deadline, and a bounded owner-scoped lazy cleanup of expired personal-token grants through public helpers. Device grants are excluded.                                                                                                |
| Follow-up proposed a 30/90/365-day expiry picker                               | Simplified to fixed 30 days for v1. This keeps the requested mint flow small; no underlying protocol choice depends on an expiry picker.                                                                                                                                                                |
| Additional personal/admin token cost                                           | Accepted: 190–290 production and 250–400 test lines. **Final total: 2,090–3,340 production plus 1,550–2,400 tests, or 3,640–5,740 total.**                                                                                                                                                              |

Additional local checks made both operator paths explicit (direct Bearer at `/api`
and in-band authentication at `/internal/rpc`), retained same-origin checks before Cap'n Web's permissive
CORS handling, and separated the Sessions UI's bounded logout guarantee from the
provider's unmodified RFC 7009 semantics. All provider claims are scoped to 0.10.3.

## Original reviewer response

Line references `L<n>` below refer to the pinned [provider v0.10.3 source](https://github.com/cloudflare/workers-oauth-provider/blob/v0.10.3/src/oauth-provider.ts). Plan line numbers refer to the initial 375-line draft. The review distinguishes source findings from engineering judgments.

**1. Verdict**

The architecture is sound and matches the released provider on nearly every point I checked. It is not ready to finalize. Two corrections would break production if implemented as written, one acceptance claim is untrue locally, and one decision reverses a recorded owner decision without saying so.

Blocking corrections:

- **Never call `updateClient()` on first-party clients.** Verified: `updateClient` re-applies `clientRegistrationTTL` to any client it saves at L5624-5629, and the default is 90 days at L1506-1508. A `createClient()` client has no expiry at L5523, so the plan's "callback changes use updateClient" at line 129 would give console and app clients a 90-day death. Register every host shape's callback at creation, and delete-and-recreate to change.
- **The refresh-token TTL key must be absent on refresh.** Verified: any callback result containing the `refreshTokenTTL` key during a `refresh_token` grant returns `invalid_request` at L2829-2834, even with value `undefined`. The plan's device rule at lines 154-158 is right for code exchange at L2590-2592, but the callback must branch on `grantType` or every device refresh fails.
- **Local lanes never enforce audience today.** Verified: `control-plane.ts:879-885` omits the whole `resourceMetadata` block on http origins, so local tokens are unbound and the slice 1 acceptance "wrong audience denied" is preview-only. Only `authorization_servers` requires https at L1597-1611; `resource` accepts http at L4634 and `authorization_servers` defaults from the token endpoint at L2298. Configure `resource` alone on http.
- **Verified login reverses a recorded decision and is under-costed.** Verified: `packages/v3/project-worker/docs/plan-auth-one-lane-2026-09-09.md:12` records "No auth.iterate.com here. The clean room's own OAuth provider IS its identity provider, for good." The new plan at lines 63-70 adopts apps/auth's OIDC. Reusing `createIterateAuth` pulls in hono, jose, oauth4webapi, zod/v4 and a local JWKS config, none of which project-worker depends on. Judgment: this needs Jonas's explicit yes, and the alternative of a small hand-written OIDC relying party against Google or apps/auth should be costed in the same bucket.

Corrections that are not blocking:

- **Cross-user revoke must check ownership first.** Verified: `revokeGrant` deletes `grant:${userId}:${grantId}` at L5739-5780, so a foreign grant id is a silent no-op, and grant ids leak through tokens and codes at L1116 and L5420. The deny-marker read must key on the token's own user id plus grant id, and the Sessions page must confirm the grant appears in the caller's `listUserGrants` before writing a marker.
- **WebSocket through the bearer gate is unproven.** Verified: with an `Origin` header present, `addCorsHeaders` rebuilds every API response with `new Response(response.body, response)` at L2185. Whether a 101 keeps its socket through that copy is not established by the snapshot, and `apps/auth/src/lib/server.ts:926` states a 101 cannot be reconstructed. Strip `Origin` from the adapter's internal dispatch, or route the upgrade around the provider and validate with `unwrapToken` plus an explicit audience check.
- **`apiRoute: "/api"` is a raw prefix match.** Verified at L2105: `/apiary` would be captured. Keep other platform paths off that prefix.

Confirmed as the plan states: public helper surface at L597-702; grant summary fields at L5710-5719; `revokeExistingGrants: false` at L5298; TTL defaults at L4545-4550; path-boundary audience matching at L4675-4678 with exact configured-resource pinning at L3882 and L4151-4166; public-client refresh with client id only at L2031-2053; token endpoint CORS and preflight at L1676-1728; RFC 7009 refresh-token revocation removing the whole grant at L3547; CIMD flag requirement at L4105.

**2. Complexity reductions**

- **Drop the per-request `unwrapToken()` call.** Verified mechanism: the callback receives `grantId` at L228 and `requestedScope` at L238; `newProps` rewrites grant props at code exchange at L2569-2602 and `accessTokenProps` sets per-token props at L2580-2583. Judgment: stamp grant id and effective scope into props there, so `ctx.props` is the full auth context and each API request saves one KV read plus one decrypt. Keep `unwrapToken` for the one-time grant lookup after a BFF code exchange.
- **Replace the two-stage console session with a server-side mint.** Judgment: after identity verification, call `completeAuthorization()` for the console client with a server-generated PKCE pair, POST the code to `/oauth/token` in-process, and store the tokens. That removes the five-minute stage 1 record, the auto-approve branch, and console callback replay. Verified: PKCE is optional for a confidential client, since the installed 0.10.3 dist requires it only when `tokenEndpointAuthMethod` is `none`; that module is outside the pinned snapshot.
- **The Durable Object is justified.** Verified: two concurrent refreshes with the same token both succeed because the previous token stays valid until a newer one is used at L2725-2731 and L2923-2928. The second success invalidates the first's new token, so an unserialized BFF loses its session. Judgment: a D1 compare-and-swap could work but the loser must discard a valid response; the DO is simpler.
- **The D1 deny marker is justified and cannot live in KV.** Verified: a refresh reads the grant at L2719 and writes it back at L2931 with no tombstone, so a stale read after `revokeGrant` resurrects the grant, permanently for a device grant with no expiry. Throwing `OAuthError` from the callback becomes a structured refusal at L2346-2350. Judgment: bound the per-request D1 read with a per-isolate 60-second known-good cache per grant, which matches the promised connection window.
- **Shrink the table.** Judgment: drop `browser_session_name`; the DO stores its own grant id and self-clears when it meets the marker. Have the callback insert the row at first exchange, which also gives the Sessions page a creation record without a second grant store.
- **Provisioning needs a table the plan omits, and idempotency.** Verified: app hosts appear at runtime through the rewrite table read in `control-plane.ts:663-675`, so "provision before concurrent requests" cannot hold. Judgment: an `app_clients` row with insert-or-ignore and a losing `deleteClient` is about forty lines. A single platform client with a P-hosted callback and a one-time handoff would remove that table, but it reintroduces a cross-host handoff step, so I do not recommend it.
- **Live capability revocation has one choke point.** Verified: every edge dispatch passes `iterate-context.ts:149-155` or the terminal-fetch branch at `iterate-context.ts:187-198`, and `cd()` shares the principal. Judgment: one per-session lease checked there covers already-held child capabilities. To close the socket, replace `newWorkersRpcResponse` in `worker.ts:229` with an owned pair passed to `newWebSocketRpcSession`, which capnweb exports. Bound grants also need a membership read, because `control-plane.ts:252-258` skips membership for explicit project lists.

**3. Gaps in tests and estimates**

Test gaps:

- The device-lifetime "accelerated clock" cannot run against deployed KV. Assert `expiresAt` is absent for the device grant and present for the browser grant in `listUserGrants` instead.
- Stale KV cannot be simulated locally. Prove marker precedence directly: write the marker without `revokeGrant`, assert the API and refresh both deny, then run `revokeGrant` and assert the cleanup state clears.
- Missing rows: Kit-origin preflight plus browser exchange; a device refresh after code exchange to catch the callback key trap; concurrent first-visit provisioning; a foreign grant id revoke returning not-found with no marker written; the RPC upgrade through the bearer path.
- The Cursor, Codex and Claude smoke is manual evidence and should be labeled as such.
- The runner default is confirmed at `playwright.config.ts:12`.

Estimates. Judgment: the plan is roughly a quarter low, mostly in Kit, firmware and tests. `specs/auth.spec.ts` is 766 lines for eight flows, and the plan proposes eleven multi-step rows plus a device simulator.

| Work                                            |        Plan |    Reviewed |
| ----------------------------------------------- | ----------: | ----------: |
| Provider config, routing, gate                  |     220–340 |     200–320 |
| Browser adapter, DO, verified login             |     450–700 |     550–850 |
| Activity, revocation, Sessions page, live lease |     220–340 |     320–480 |
| Client provisioning and ingress                 |     150–230 |     150–250 |
| Kit OAuth and config image                      |     100–160 |     180–300 |
| ESPHome component and device HTTP operation     |     350–600 |     500–850 |
| Production total                                | 1,490–2,370 | 1,900–3,050 |
| Tests                                           |   900–1,400 | 1,300–2,000 |
| Total                                           | 2,390–3,770 | 3,200–5,050 |

Kit has no OAuth code today and needs a callback route, PKCE state, and revoke-on-cancel. The firmware bucket omits partition parsing, Wi-Fi injection, the Python codegen, and the catalog and checksum pipeline. The removal estimate of 200 to 350 lines is plausible.

**4. Minimal recommended final design**

- One authorization server at the platform origin; canonical resource `P/api`; MCP at `/api`, Cap'n Web at `/api/rpc`; pin `resource` on http origins too.
- One `tokenExchangeCallback` does four things: deny-marker check from primary D1, device `refreshTokenTTL: undefined` on code exchange only, grant id and effective scope stamped into props, membership recheck. No per-request `unwrapToken`.
- Console is a confidential client whose grant is minted server-side at login and exchanged in-process; tokens live in one BrowserSession DO class behind a `__Host-` cookie. No stage 1 record.
- Verified identity is an explicit owner decision between importing `@iterate-com/auth/server` with its dependencies or a small hand-written OIDC relying party; either is counted in the adapter bucket.
- Docs and Voice use per-installation confidential clients created at first login with an idempotent D1 row, all host callbacks registered at creation, and `updateClient` never called.
- Kit uses one public firmware-family client with browser PKCE and CORS exchange, revokes with RFC 7009 on cancel, and flashes issuer, client id, resource, project, device id and refresh token.
- Two small D1 tables: a per-grant local row with user id, grant id, client id, created, last used, revoked, and cleanup pending, inserted by the callback; and the app client mapping.
- Revocation order: ownership check, marker, `revokeGrant`, clear pending. The API gate and refresh consult the marker through a 60-second per-isolate cache; each socket holds a lease that rechecks every 60 seconds and closes its owned WebSocket.
- Sessions page is one GET joining `listUserGrants` with the local rows and one POST that verifies ownership before acting.
- Tests replace the auth spec, add sessions, Kit and lifecycle files, prove marker precedence and `expiresAt` inspection deterministically, and use preview for HTTPS and cross-site proof with hardware as manual acceptance.

## Revised-plan follow-up

This check followed the first set of corrections and preceded the additional personal/admin-token requirement. Its four wording fixes are now incorporated. Its numerical totals refer to that earlier scope.

**Verdict:** the revised plan is coherent. Every listed revision is internally consistent with its disposition, the estimate table sums correctly, and no remaining item requires a design change. Four wording gaps would stall implementation; exact fixes follow.

**1. Console client redirect URI is unstated.** The in-process mint still needs a registered redirect URI, because `parseAuthRequest()` rejects unregistered values. Add to step 1 of "After identity verification":

> "The console client registers one internal redirect URI that no browser ever visits. The synthetic authorization request and the in-process token request both carry that exact value."

Also state where the console client's secret lives. Suggested: "The console client is an `app_clients` row of kind `console` at origin P."

**2. Props carry-forward is implicit.** Returning `accessTokenProps` replaces the token's props. If the callback returns only the stamped fields, the gate and `/api/session` lose the project ceiling and device ID. Replace the stamping sentence in "Provider integration" with:

> "The callback returns `accessTokenProps` as the grant props spread with grant ID, client ID, user ID, effective scope, and deadline. Project ceiling and device ID must therefore be stored in grant props at `completeAuthorization()`, not only in display metadata."

And in "Only the state missing from the provider", change "App/device display labels and project IDs stay in the provider's grant metadata" to:

> "Display labels stay in grant metadata; project IDs and the device ID live in grant props, where enforcement reads them."

**3. Identity callback host scope.** The adapter intercepts `/.auth/*` at every trusted host, but Google's callback must exist only at P. Add after "Use a distinct `P/.auth/identity/callback`":

> "Serve this route only at P; app hosts return 404 for it."

**4. Estimate rows for the two new endpoints.** The firmware row's "minimal HTTP operation" reads as device-side only. Add to row 1: "including the `/api/session` and `/api/device-events` worker handlers." Arithmetic is already correct: 1,900–3,050 production, 3,200–5,050 total, 1,220–1,900 platform portion.

**Checked and consistent:**

- Console grant minted via public helpers after Google identity, distinct callback, no temporary identity session, logout clears local SSO.
- No apps/auth import; recorded owner decision preserved; bare email stays a local fixture.
- Callback branches on grant type; `refreshTokenTTL` key present only at code exchange; deadline capped at access-token TTL; effective scope from `requestedScope`.
- `updateClient()` never called; swap-and-delete with explicit reauthorization.
- Fresh primary D1 for new admissions and refresh; 60-second lease only for live connections; hard expiry checked independently of timers; owned WebSocketPair; synchronous `onCall`.
- Origin removed on internal WS dispatch only after the real Origin check; native bearer upgrades handled at the trusted entrypoint; browser test proves the 101 survives.
- Explicit `app_clients` table with insert-or-ignore and losing-candidate deletion.
- `/api/session` serves both Kit's approved project/device ID and the adapter's ingress identity, through the same bearer gate.
- `/api/device-events` accepts one bounded event into the token's single project.

**Plan limitations, not blockers:**

- Every new HTTP admission adds one D1 primary read plus a membership read. Streamable MCP pays this per request. State the cost explicitly rather than leaving it implicit.
- Whether 0.10.3 also validates `redirect_uri` at token exchange was not verified by the first review. Fix 1 is correct either way.
- The provider stores only a secret hash, so the D1 `client_secret` column is the sole plaintext copy. Note D1 export exposure when choosing "server-only storage."
- The OIDC library is unnamed. It is a new project-worker dependency and belongs in row 2's estimate, where it already fits.
- `listUserGrants` is paginated. Ownership confirmation before marker write must page until the grant is found or the list ends.
- The instruction to use `env.DB.prepare` without a replica session assumes the repo does not already use D1 sessions. That is unverified.

## Personal and admin token follow-up

This targeted source audit covers the later user requirement. Option A is the provider-grant design adopted in the final plan; option B is a separate application-owned hashed-token store. The suggested expiry picker is simplified to fixed 30 days; the remaining recommendation is incorporated.

Recommendation: **Option A**, with `refreshTokenTTL: 0` and a lazily swept grant row. Option B is not simpler once the plan's grant inventory, activity table, and revocation contract exist.

## Concrete design

**One confidential first-party client** named "Personal tokens", created with `createClient()` beside the console client, `client_secret_basic`, one exact redirect URI on the platform origin that serves nothing but 404. Its secret stays server-only.

**Mint** is one authenticated POST server function on the Sessions page. It validates label, chosen TTL, and projects against current membership, then runs the console's existing in-process code flow: synthesize the authorize URL with a server-generated S256 pair, `parseAuthRequest()`, `completeAuthorization()` with `revokeExistingGrants: false`, `metadata: { kind: "personal-token", label, expiresAt }`, `scope: ["iterate"]`, and props `{ actor, email, projects, auth: { kind: "personal-token", ttl } }`. Read the code from `redirectTo`, POST it to `/oauth/token` in-process with the client secret and verifier. Show `access_token` once. The response contains no `refresh_token`.

**Callback branch.** When `clientId` is the personal-token client and `grantType` is `authorization_code`, return `{ accessTokenTTL: clampedTtl, refreshTokenTTL: 0, accessTokenProps: { ...props, grantId, clientId } }`. For `refresh_token` on that client throw `OAuthError('invalid_grant')`. This is defensive only, since no refresh credential exists.

**Inventory, last use, revoke** are exactly the plan's: same `oauth_activity` row keyed by user and grant, same gate hook, same ownership check, same `revokeGrant()` POST. The Sessions page renders personal tokens as rows with the label from metadata.

**Expired rows.** With `refreshTokenTTL: 0` the provider leaves `grantData.expiresAt` undefined and saves the grant with no KV expiration, so the row outlives its only access token. The access token itself expires by KV TTL and the middleware rejects it. Manage the row honestly: the list function marks rows whose `metadata.expiresAt` has passed as "Expired", and the same request revokes them owner-scoped through `revokeGrant()`. No private KV access. `purgeExpiredData()` will not help because it only purges grants that carry `expiresAt`.

Alternative, not recommended by default: set `refreshTokenTTL` equal to the access TTL and discard the returned refresh token. That yields a native `expiresAt` and KV auto-deletion, but the grant then holds a live refresh hash whose secret existed transiently in the worker, and the callback must refuse refresh for this client. Choose it only if native expiry display matters more than "no refresh token exists".

## Source constraints verified in the pinned 0.10.3 file

| Constraint                                                                                                         | Lines                |
| ------------------------------------------------------------------------------------------------------------------ | -------------------- |
| Callback `accessTokenTTL` applies per exchange; `refreshTokenTTL` honored when key present at code exchange        | 2585-2592            |
| `refreshTokenTTL: 0` skips refresh token; `expiresAt` stays undefined; grant saved without expiration              | 2621-2653, 4057-4058 |
| Access TTL has a 60 s minimum and no maximum; KV TTL holds the token record                                        | 1517-1524, 4197-4235 |
| A grant with no refresh hash cannot be refreshed                                                                   | 2721-2731            |
| `revokeExistingGrants` defaults true; a second mint would revoke the first                                         | 5298-5316            |
| Token string is `userId:grantId:secret`; the PAT reveals both. The plan's colon-free opaque user IDs mitigate this | 4205, 5420           |
| `resolveExternalToken` null yields 401; `audience` must exactly equal the configured resource                      | 3951-3970            |
| Expired provider tokens are rejected at the middleware and by `unwrapToken()`                                      | 3894, 1785           |
| `OAuthError` thrown from the callback becomes a structured refusal                                                 | 2346-2362            |
| `GrantSummary` exposes `metadata`, `createdAt`, `expiresAt` for the UI                                             | 5710-5719            |

No blocker. Nothing requires provider changes, implicit flow, or a fabricated helper.

## One principal, one gate

Define `AuthContext = McpProps & { auth: { kind: "admin-secret" } | { kind: "oauth"; grantId; clientId } }`.

- **Admin Bearer at `/api`.** `resolveExternalToken` calls only `verifyAdminSecret` and returns `{ props: { actor: "admin", auth: { kind: "admin-secret" } }, audience: "<origin>/api" }`. Anything else returns null and fails. Retire project-token and project-secret candidates there in slice 6. No `as` impersonation over Bearer.
- **Provider tokens** always arrive with `auth.kind === "oauth"` stamped by trusted code. The gate accepts `actor === "admin"` only under `kind: "admin-secret"`, which only the external resolver sets.
- `reachOf` is unchanged: admin reaches every project; a personal token reaches its `projects` list, intersected with current membership as the plan already requires.
- Activity rows, leases, revocation markers, and Sessions listing apply only to `kind: "oauth"`. The admin has no grant, no row, and no user-facing revoke.
- **Two admin doors, one verifier.** `/internal/rpc` stays the in-band lane where fixtures call `authenticate({ type: "admin-secret" })` inside the Cap'n Web session and the provider is not involved. `/api` Bearer is the header credential through provider middleware for MCP and HTTP. Both call `verifyAdminSecret`.

## Option B verdict

App-owned hashed PATs need a table, random secret plus prefix, hash lookup in `resolveExternalToken`, separate expiry and last-use columns, a second revoke path, and a second list merged into the Sessions page. Every one of those already exists for grants. Its only gains are a native expiry column and no user ID in the token string. It splits the inventory for less than it saves.

## Additional UI and e2e cases

- Mint shows the token once; response has no `refresh_token`; second mint leaves the first working.
- Token reaches MCP at `/api` and RPC at `/api/rpc`; a project outside its selection is denied; empty selection reaches nothing.
- Revoke from Sessions denies new use and stops a held capability within the plan's window.
- Clock-controlled expiry: token gets 401, row shows "Expired", next list sweeps it.
- `refresh_token` grant with the personal-token client returns `invalid_grant`; a browser visiting `/authorize` for that client is refused by the consent page.
- Admin secret as Bearer works at `/api` and MCP, appears in no Sessions list, writes no activity row; a wrong secret gets 401; in-band `/internal/rpc` fixtures still pass.

## Incremental LOC

| Work                                                                                                  |     LOC |
| ----------------------------------------------------------------------------------------------------- | ------: |
| Client registration, callback branch, mint function, expiry sweep, admin resolver retag, gate tagging | 130-190 |
| Sessions page rows, mint form, show-once view                                                         |  60-100 |
| Production total                                                                                      | 190-290 |
| E2E and focused tests                                                                                 | 250-400 |

Defaults chosen where the requirement was silent: TTL picker of 30, 90, or 365 days capped at 365 with 30 default; explicit project selection only, never "all current and future"; labels editable only by revoke-and-remint. None of these blocks the plan.
