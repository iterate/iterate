# Minimal unified OAuth implementation

Historical research/planning record. The implemented design is documented in
[Unified OAuth and the issuer app](unified-oauth-architecture.md); it supersedes
implementation choices and status statements below.

2026-09-10 · Implementation underway in `packages/v3/project-worker`.

**Owner corrections during implementation:** `/api` is Cap’n Web. The public MCP
endpoint is `https://mcp.iterate2.com/`; `/mcp` may be its internal route. The issuer
and console are `https://os.iterate2.com`. These are separate resource audiences
served by one authorization server and provider store. Both the console and
userspace browser apps use the same CIMD + code/PKCE client implementation; the
app-client registration table and special console bootstrap below are superseded.
The current implementation contract and acceptance checklist live in
[the build notes](../packages/v3/project-worker/docs/unified-auth-build.md).

Use the released `@cloudflare/workers-oauth-provider` **0.10.3**, without a fork,
to own every user-facing application's grant, access token, refresh token, and
revocation. Keep the existing TanStack Start console and trusted project ingress.
Add one shared browser adapter, a small amount of session state, and one Sessions
page. Devices get their own credentials through Kit before flashing. Preserve the
global admin bearer from env/appconfig, and let individuals mint named API access
tokens that act as them within selected projects.

This follows the [unified-auth research](clean-room-oauth-unification-research.md)
and [device research](kit-device-oauth-research.md). It replaces their open choices
with the decisions below. RFC 8628 Device Authorization and the `.local` Login
button are deferred; there is no temporary LAN callback protocol to remove later.
The separate uncommitted V4 work is outside this plan.

## 1. Decisions that keep the implementation small

| Decision                                                            | Implementation consequence                                                                                                                                                                        |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One authorization server per environment, on the platform origin    | Console, project apps, Kit provisioning, and MCP share login and provider storage.                                                                                                                |
| Distinct public protocol endpoints                                  | Cap’n Web stays at `https://os.iterate2.com/api`; MCP is `https://mcp.iterate2.com/`. Both use the same provider and authorization policy.                                                        |
| Project apps are clients of Iterate                                 | A Docs/Voice hostname does not need a separately registered resource server, JWT validation, or token introspection.                                                                              |
| One OAuth scope initially: `iterate`                                | It grants the existing project capability surface within the selected projects. No new per-operation permission language. An absent effective scope grants no API access.                         |
| Provider grants use Authorization Code + S256 PKCE                  | Confidential clients for platform-managed backends and personal-token minting; a public client for each firmware family; external MCP clients use their normal registration and browser callback. |
| Public Dynamic Client Registration is disabled                      | External clients use CIMD; trusted platform code can still call `createClient()`. No public `/oauth/register` endpoint or DCR fallback.                                                           |
| One grant per browser/app login, physical device, or personal token | Set `revokeExistingGrants: false`; logging into Docs on a second browser must not revoke the first. Tabs in the same browser session reuse its grant.                                             |
| One small browser-session Durable Object implementation             | Keeps tokens server-side and serializes refresh for every platform-managed hostname. The console creates its ordinary code grant in-process after login.                                          |
| Provider grant list is the inventory                                | Do not duplicate provider grants, token hashes, grant scope, or refresh lifecycle in our database.                                                                                                |
| Personal API tokens are provider access tokens                      | One named grant per token, the issuing user's principal, the same last-used/revoke UI.                                                                                                            |
| Configured global admin bearer remains supported                    | Use the provider's existing `resolveExternalToken` hook and `verifyAdminSecret`; no fake user grant or separate public API.                                                                       |
| Two small D1 tables                                                 | A trusted app-to-client registration map, plus last use and a durable revocation marker per grant.                                                                                                |

Both provider-issued user tokens and the configured admin bearer use the shared
authorization policy at the Cap’n Web and MCP endpoints. Retire the custom signed user/project-token
and device project-key paths from these covered flows. Removing unrelated machine
integrations is not required to ship this change. Preserve their existing in-band
`authenticate` gate at `/internal/rpc`; it still verifies credentials and is not
trusted merely because of its name. Existing fixture clients can move there without
changing their authentication calls; direct admin bearer clients use `/api`.

**Protocol routing:** preserve `/api` for Cap’n Web. Give MCP its configured
`mcp.iterate2.com` origin, with resource metadata describing that public address.
The authorization server accepts only the configured API resource audiences;
a resource audience is not an instruction to move a protocol to another path.

**Client registration policy:** omit `clientRegistrationEndpoint` from the provider
configuration. Discovery must omit `registration_endpoint`, and `/oauth/register`
must return 404. Enable `clientIdMetadataDocumentEnabled: true` and the
`global_fetch_strictly_public` compatibility flag; advertise public-client token
authentication (`none`) and require S256 PKCE. Internal `createClient()` remains
available for the console, shared app adapter, personal-token minting, and Kit;
turning off the public endpoint does not disable that helper.

The [MCP 2026-07-28 specification](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization#overview)
recommends CIMD and deprecates DCR as a compatibility mechanism. Arbitrary userspace
apps may use CIMD just like external MCP clients by hosting HTTPS client metadata
and handling the code flow, or use the platform-managed browser adapter with its
automatic internal client provisioning. Neither requires manual registration by
the app author. CIMD support is a SHOULD, so verify the exact supported client
versions in preview; do not claim every installed client implements it. A client
without CIMD needs an explicit supported alternative, such as preconfigured client
credentials, or a newer version. There is no automatic DCR compatibility path.

## 2. Login by device and hostname

Let `P` be the environment's configured platform origin, such as the eventual
`https://os.iterate.com`. Origins come from deployment configuration and the trusted
project/app directory; arbitrary `Host`, `next`, and client-supplied URLs cannot
choose an issuer or callback.

| Where the user starts                              | Login and callback                                                                                                                             | What remains signed in                                                                                                 |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Console at `P`, on desktop or mobile               | Verified login at `P/login`; the backend completes its own provider code flow in-process                                                       | This browser's console grant and host-only session cookie.                                                             |
| `https://docs--<project>.<project-base>` or Voice  | That host's `/.auth/login` → `P/authorize` → that exact host's `/.auth/callback`                                                               | A distinct app grant; the trusted platform backend holds its tokens.                                                   |
| Another app/project hostname                       | Same adapter, another pre-registered installation and exact callback                                                                           | Its own app/project grant. No wildcard or parent-domain cookie.                                                        |
| Cursor, Codex, Claude, or a native CLI             | Discover `https://mcp.iterate2.com/`; use CIMD (or explicitly preconfigured credentials); normal code + PKCE to the client's declared callback | Provider access/refresh tokens in the client's own credential store; exact supported versions are verified in preview. |
| An individual's script or other bearer-only client | User selects “Create API token” in Sessions, names it and selects projects, then copies the access token once                                  | A distinct provider grant acting as that user; no browser login needed on the consuming machine.                       |
| Operator automation                                | Send `Authorization: Bearer <APP_CONFIG_ADMIN_API_SECRET>` from the environment/appconfig                                                      | Explicit global admin principal; lifecycle is configuration rotation, not a user session.                              |
| Kit at `https://k.iterate.com` before flashing     | Public firmware-client code + PKCE; HTTPS callback at Kit                                                                                      | A dedicated physical-device grant, whose refresh token goes into one board's configuration.                            |
| ESP32 after flashing                               | Outbound HTTPS refresh and resource requests; no browser required                                                                              | Its current rotating refresh token in writable durable storage.                                                        |
| Device UI at `http://speaker.local`                | Deferred until Device Authorization is implemented                                                                                             | Already-provisioned devices continue working; no `.local` OAuth redirect.                                              |
| Local development and previews                     | Same flows with separate issuer, clients, storage, and exact environment callbacks                                                             | No production tokens, clients, or cookies reused.                                                                      |

SSO is a **top-level navigation to `P`**, which can read its own cookie. Cross-site
cookies, iframes, and cookies shared across `.iterate.com`/`.iterate.app` are unnecessary.
First-party status comes from the installation directory, never a client name or URL
supplied by an arbitrary OAuth client.

### Verified human login and the console's own grant

Preserve the [recorded owner decision](../packages/v3/project-worker/docs/plan-auth-one-lane-2026-09-09.md):
the clean room owns its issuer, login page, and user directory; there is no
`auth.iterate.com` dependency. The email form currently proves no identity.
For public deployment, add the already-planned Google sign-in to that same page,
using a small OIDC relying party built on `oauth4webapi`. The email
field is a login hint; bare-email sign-in remains an explicit local-test fixture.
This first public slice supports Google identities; an email-OTP login method is
separate follow-up work, not secretly included in the LOC estimate.

Use a distinct `P/.auth/identity/callback` for Google, served only at `P`; app hosts
return 404 for that route. Verify state, PKCE, nonce,
issuer, audience, expiry, and verified email, and map `(issuer, subject)` to a
stable colon-free local user ID. Add that identity mapping to the existing users
schema. This is upstream proof of the human only; Google credentials are not
Iterate API tokens. Do not import the old auth app or its token-cookie handler.

After identity verification, create the console's grant **server-side**:

1. Generate a code-flow request and S256 PKCE pair for the registered console client.
   Its `app_clients` row has kind `console`, holds its client secret, and registers
   exactly `P/.auth/console-grant` as a synthetic redirect URI. No browser visits
   this URI; the authorization and token requests both carry that exact value.
   Validate it with `parseAuthRequest()`, then call `completeAuthorization()` for
   this verified human and the console's fixed permissions.
2. Read the code from its returned redirect URL and exchange it through the same
   provider's `/oauth/token` handler in-process, using the client credential and
   verifier. The provider still issues and validates the code and tokens normally.
3. Store the tokens in BrowserSession, set its host-only cookie, and return to the
   original page or external authorization. No temporary SSO identity session or
   extra console browser callback is needed.

That console session also supplies platform SSO. Every console/consent read checks
its grant's validity and revoked state; possessing an old identity field alone
cannot bootstrap a fresh grant after logout. External clients and project apps
still use the standard browser redirect flow and existing consent/project UI.

Logging out this console browser clears its local SSO identity as well as its grant.
It shows the signed-out page and does not immediately start SSO again. An upstream
identity-provider cookie may still exist; signing in again requires an explicit
user action, and does not require globally signing out unrelated upstream apps.

### Shared browser adapter

Intercept `/.auth/login`, `/.auth/callback`, `/.auth/logout`, and `/.auth/rpc` at
trusted platform/app hosts. One `browser-auth.ts` module owns these routes; one
`BrowserSession` Durable Object implementation owns their mutable credentials.

- Set a random, opaque `__Host-itx-session` cookie: Secure, HttpOnly, SameSite=Lax,
  Path=/, no Domain. Bind its server-side record to the exact origin and client.
  Use the cookie's hash to address the session; never expose DO identifiers as a
  separately sufficient public credential. Local parallel ports need an origin-
  derived cookie-name suffix: browser cookies themselves are not port-scoped.
- Store pending OAuth transactions server-side: state, PKCE verifier, issuer,
  client, exact callback, safe relative return path, and five-minute expiry. Bind
  them to the initiating browser, consume once, and preserve separate transactions
  for concurrent tabs. After exchange, remove the callback query by redirecting.
- Hold access/refresh tokens in the DO. Serialize refresh across requests and
  isolates; persist replacements before returning success. An interrupted exchange
  has an explicit recoverable or terminal state, rather than blind code replay.
- Identify the resulting grant with public `unwrapToken()` after code exchange;
  `completeAuthorization()` returns only `redirectTo`. Never split a token or
  inspect private KV keys to recover the grant ID.
- Browser RPC connects to same-origin `/.auth/rpc`. The trusted adapter resolves
  its session and dispatches an internal request to canonical `P/api` with that
  app's access token through the provider. This is fixed server routing, not an
  endpoint accepting arbitrary target URLs.
- Protect cookie-authenticated mutations and WebSocket handshakes with exact
  Origin/CSRF checks. The callback is the narrowly scoped cross-site GET exception.
  Do not rely solely on TanStack route guards or SameSite cookies.
- After checking the original browser Origin, remove `Origin` on the internal
  canonical WebSocket dispatch. The provider's CORS helper otherwise reconstructs
  the 101 Response; do not assume that preserves its socket. Preserve the original
  upgrade Response end to end and prove it in the browser test. Native bearer
  upgrades need the same deliberate Origin/101 handling at the trusted entrypoint.

For project-page fetches, the adapter validates the app's provider token and passes
the resulting constrained principal through the existing trusted ingress. Preserve
the common gate by making this an internal bearer request to `P/api/session`,
whose safe response supplies the checked identity/project/scope context. Preserve
internal header stripping. A separately deployed, trusted app backend can receive
that **app's short-lived Iterate access token** to call `P/api`; it never receives
the console's token, browser cookie, or refresh token. This is credential delivery
within the app client, not a new public bearer-token resource at every app hostname.
Use the existing authenticated platform-to-backend channel or a private Workers
Service Binding; a public backend cannot trust caller-supplied identity headers.

Register console and app-installation clients through `createClient()` in trusted
code. Add `app_clients(installation_key, client_id, client_secret, origin,
project_id, kind)` to the directory, with a unique installation key. Keep secrets
in server-only storage. Project apps can appear dynamically through rewrite rules,
so lazily ensure the client on the first authorized visit to an installed app.
Create a candidate, insert-or-ignore the mapping, and delete a losing candidate
before redirecting with the winner. Handle storage failure with bounded cleanup;
do not silently accumulate registrations on retries or register on every visit.

Register exact callbacks at creation. **Do not use `updateClient()` in 0.10.3**:
it applies the default 90-day DCR expiry even to previously persistent clients.
A callback/hostname change creates and swaps a new registration, then deletes
the old one with explicit reauthorization. Ordinary app updates keep the client.

### Kit and ESPHome

Kit uses a pre-registered public firmware-family client. Its own page need not
acquire a separate long-lived Kit grant merely to flash a device: choose the
project on the central consent page and clearly name the device being authorized.
The authorization request's display input is bounded and treated as untrusted;
the platform chooses the actual project/client permission ceiling.

Keep state/PKCE verifier only for the pending browser transaction. Exchange the
code at Kit and hold the returned device tokens in memory. Call protected
`GET /api/session` with the access token to obtain the **approved** project and
platform-generated device ID; opaque OAuth tokens and the standard token response
do not themselves expose those fields. Flash `{ issuer,
clientId, resource, projectId, deviceId, refreshToken }` with Wi-Fi configuration
into exactly one board. Do not reuse the image for another board. Revoke cancelled
provisioning when credentials remain available; the session screen can revoke an
abandoned installation after a tab closes. Kit relinquishes its token copy after
provisioning and does not refresh it concurrently with the device.

Add a small ESPHome external component: verify HTTPS, import provisioning once,
refresh serially, commit each replacement token durably, and call the selected
Iterate HTTP operation: `POST /api/device-events` validates one bounded JSON event
and calls the existing append operation in the token's one project. It does not
accept a caller-selected project or introduce another expression/RPC protocol.
Preserve the current credential across reboot and OTA. Reset clears both the
current NVS credential and its original provisioning data so it cannot be imported
again. Test lost responses and power loss around NVS commits. Stock
firmware currently does not implement Iterate; the catalog has no released
Iterate firmware, so one real board/build is part of this slice.

Keep the provider's one-hour access-token default. Retain its absolute 30-day
refresh-grant default for browser/MCP clients. For device grants, select explicit
`refreshTokenTTL: undefined` at initial code exchange: revocable, no absolute
expiry. Omitting this property would retain the 30-day default. Ownership follows
the authorizing human's current project membership in v1; removal stops the device.

## 3. Authorization, last use, and logout

### One checked principal for both bearer kinds

Use a small discriminated authorization context: either a verified `admin` bearer,
or a `user-grant` carrying the user ID, grant/client IDs, scope, project ceiling,
and expiry. Both produce the existing event principal and use the same resource
handlers. The principal answers who acts; the checked context also limits what
they may do. Do not infer administrator status from caller-supplied `actor` text.

Keep the existing constant-time `verifyAdminSecret(token, appConfig.adminApiSecret)`
inside `resolveExternalToken`. On success, return the explicitly tagged admin
context, principal `{ actor: "admin" }`, and the fixed configured audience `P/api`.
Never derive this audience from a supplied Host or project URL. A blank, incorrect,
or superseded secret returns null and the normal provider 401. The admin branch
has platform-wide authority without user membership, grant ID, or refresh token;
it does not query a fabricated grant or enter user-grant callbacks. Normal API
input validation and trusted-ingress checks still apply.

The global token is never exposed in the browser UI or listed as a user's session.
Its invalidation is deployment configuration rotation. That is distinct from the
per-grant logout contract below; do not claim a Sessions button rotates operator
credentials or terminates admin transports across a rolling deployment.

Personal tokens use `{ actor: issuingUserId, email? }`, with the same current-
membership intersection and durable revocation checks as other user grants.
Individual minting does not accept an arbitrary actor, user ID, or admin flag.
The reserved admin actor must never be allocated as a local user ID.

### Personal API tokens, without another token store

Use one persistent confidential client of kind `personal-token` in `app_clients`,
with `client_secret_basic` and exact synthetic redirect `P/.auth/personal-token`.
That URL serves 404; no browser visits it. The public consent route refuses this
internal client. Only the authenticated mint action may authorize it, just as only
verified login authorizes the internal console client.

The Sessions page has a small “Create API token” form: required label, explicit
project selection, and a **fixed 30-day expiry** displayed before creation. These
are personal tokens acting as the signed-in user, not service accounts. No expiry
picker, arbitrary principal editor, or all-future-projects permission is needed.

One POST server function validates the input against current membership and reuses
the console's in-process authorization-code + S256 PKCE exchange. Pass
`revokeExistingGrants: false`; each mint creates a distinct grant. Grant props carry
the principal, chosen project ceiling, trusted token kind, and absolute expiry.
Grant metadata carries its label, kind, and the same expiry for display.

The exchange callback recognizes the registered personal-token client and, on
initial code exchange only, sets the remaining finite `accessTokenTTL` and
`refreshTokenTTL: 0`. The provider's access TTL must be at least 60 seconds; refuse
an issuance whose remaining lifetime falls below that. Stamp the same absolute
authorization deadline into access props, and enforce it on every admission and
live call. Refuse refresh grants for this internal client defensively. Return the
actual `access_token` once in a no-store mutation response; never return it from
SSR/loaders, log it, or keep a second plaintext copy. A lost response means remove
that unused grant and explicitly mint again. No fabricated mint helper, implicit
flow, or client-credentials extension is required.

There is one provider wrinkle: disabling refresh leaves its grant summary without
`expiresAt` and without automatic KV expiry, even though the access token expires.
Use our trusted metadata expiry for personal-token rows, not the missing provider
field. A list request reports newly expired rows as “Expired” and triggers bounded,
owner-scoped cleanup through the existing marker + `revokeGrant()` operation; the
next list omits successfully cleaned rows. Only sweep this registered client and
its validated expiry metadata, never all grants lacking `expiresAt`—devices are
intentionally non-expiring. Keep cleanup failures visible and retryable. Dormant
accounts retain expired metadata until next listing; it carries no live authority.
No global sweeper, private KV access, or separate hashed-PAT table is needed.

### Provider integration

The provider's `apiHandler` validates bearer tokens and the canonical audience.
Avoid a duplicate lookup there: the exchange callback returns `accessTokenProps`
as **the grant props spread with** trusted grant/client/user IDs, effective scope,
and a conservative authorization deadline. The middleware supplies these as
`ctx.props`. Store the authorization-bearing project ceiling and device identity
in grant props at `completeAuthorization()`, so stamping cannot lose them. The provider
still owns actual access-token expiry and validation. Keep public `unwrapToken()`
for the one-time association after a browser backend exchanges a code.

Permission is the intersection of effective `iterate` scope, the grant's project
ceiling, the trusted installation's project ceiling, and current user membership.
Console grants may follow current membership; app/device grants name one project;
MCP and personal-token grants name the selected projects. An empty selection means zero projects,
never all current or future projects. User-authorized clients cannot mint legacy
project/admin credentials to escape revocation.

Use `tokenExchangeCallback` to recheck revoked state and current policy at initial
exchange and refresh, and choose device/personal-token lifetimes. Resource requests repeat
the authorization check, so a stale token or issuance/revocation race cannot restore
access. A device's principal records both its device identity and authorizing user.
Set `accessTokenScope` and the scope in `accessTokenProps` to the same narrowed
value, using the callback's `requestedScope`, not the grant's scope ceiling.
Set the access deadline immediately before returning the callback result, no
later than `now + accessTokenTTL`; the live lease may expire conservatively early.
**Return `refreshTokenTTL` only for an `authorization_code` exchange.** The entire
key must be absent for `refresh_token`, including an `undefined` value, or 0.10.3
returns `invalid_request`. The callback can insert the empty activity row once;
its execution does not prove token issuance finished or that a device connected.

### Only the state missing from the provider

Add one `oauth_activity` table to the existing D1 directory:

```text
(user_id, grant_id) primary key
last_used_at nullable
revoked_at nullable
provider_cleanup_pending boolean
```

Display labels stay in the provider's grant metadata. Project IDs and device ID
live in grant props, where enforcement reads them; metadata may duplicate them
for display but never supplies authority.
Browser credentials and login transactions stay in the DO, not this table. No
second token/grant store or generic session framework. A BrowserSession stores
its own grant ID and self-clears on observing revocation, so no reverse DO lookup
or copied client/created-at columns are needed in this table.

**Last used** means the last accepted authenticated resource request or application
operation, including operations on a long-lived RPC connection. Merely viewing the
Sessions page or refreshing a token does not touch other clients' activity. Record
first use and then coalesce activity writes to roughly minute precision per worker;
use monotonic SQL updates so concurrent writers cannot move time backwards. Unknown
activity displays “Not used yet,” not an invented login/use timestamp. Surface
recording failures as operational defects; do not silently suppress them.

### A logout contract that also covers live connections

`revokeGrant()` deletes KV records; KV is eventually consistent, and deletion alone
does not stop an already-issued RPC capability. Reuse the activity row for a small
durable deny marker instead of promising instantaneous global KV invalidation.

1. Authenticate the user, confirm ownership through their provider grant list
   (paging until found or exhausted),
   and write `revoked_at`/cleanup-pending against their grant. A foreign/missing
   grant is not-found and writes no marker; an existing marker owned by this user
   permits an idempotent repeat or cleanup retry. Always key checks by the verified
   token's **user ID and grant ID together**.
2. Call
   `revokeGrant(grantId, signedInUserId)`. Clear cleanup-pending on success.
3. Deny new resource requests and refreshes once the marker is committed, even
   if a KV read is stale or a refresh already in flight writes a token afterward.
   Use fresh primary D1 reads (`env.DB.prepare`, without a replica session) for
   these new HTTP/token admissions. Do not cache an allow decision for 60 seconds
   on those paths; that would weaken this immediate-admission contract.
   Budget a primary D1 deny check plus current-membership lookup per admission,
   including each Streamable MCP request; this consistency contract has a latency cost.
4. Revalidate active RPC/MCP/stream authorization at most every **60 seconds**, and
   never beyond token expiry. On revocation or membership removal, close/dispose
   the transport and recall its session-owned capabilities through existing
   `SessionTeardown`. Shared dispatch must not keep executing on an expired lease.
   Prove this for already-held child/returned capabilities, not just new `projects.get`.
5. Already-accepted mutations may finish. After the 60-second connection window,
   no further operation on that authorization may begin. A client explicitly
   reauthorized by the user receives a new grant; ordinary reconnect cannot do so.

Use the existing Cap'n Web `onCall` hook for activity and a synchronous lease check;
renew the lease separately through primary D1. The hook must invoke synchronously
to preserve RPC ordering: never await a DB lookup before invoking through it.
Check hard expiry even if a timer is delayed. Own the server WebSocketPair so the
session monitor can close it. Keep checks at native dispatch/terminal-fetch entry
where a forwarded capability bypasses a local call hook. Test the resulting
capability lifetimes rather than assuming one hook covers every transport.

This 60-second guarantee is for the Sessions page/app logout operation. Ordinary
client-side RFC 7009 revocation continues to have the provider's KV semantics;
its endpoint is `/oauth/token` with `token` and no `grant_type`. Kit uses that
standard operation to cancel an unflashed grant. Do not claim a library-internal
revocation automatically writes our marker or closes a live socket.

A failed provider deletion leaves access blocked and a visible retryable cleanup
state; it is not reported as fully completed. Retain revocation markers so stale
or racing writes cannot resurrect a non-expiring device grant. Storage outages
produce classified service errors and fail closed. This adds a deny check, not
replacement OAuth token issuance or a second revocation protocol.

## 4. Small TanStack Start Sessions page

Add `src/routes/_auth/sessions.tsx` using the existing authenticated layout and
server-function middleware. Add a link from the account page. Reuse existing CSS,
buttons, forms, and error handling; no dashboard framework or new component library.

```text
Sessions

App / device                 Project       Last used      Action
Iterate · this browser       Your projects Just now       Log out
Docs · Chrome               Project A     4 minutes ago  Log out
Voice · Safari              Project A     Yesterday      Log out
Claude                      Project A, B  12 minutes ago Log out
Kitchen speaker             Project A     1 minute ago   Log out
Deploy script · API token   Project A     8 minutes ago  Revoke

Create API token: [Name] [Projects]   Expires in 30 days   [Create]
```

Use one GET server function to call paginated `listUserGrants(userId)` and join
activity. Return display fields only, with a “Load more” cursor. Show distinct
grants under the same app/client name; do not infer “online” or unique physical
devices from third-party client IDs. First-party browser labels use a small UA
description; devices use the approved label; third-party labels identify the client
and creation time when no trustworthy installation label exists. Personal-token
rows also show expiry; they share last-use and revoke behavior. Include outstanding
cleanup markers even when a provider deletion has already removed its summary,
so partial cleanup cannot disappear from the visible queue.

One POST server function logs out a grant. Derive the owner from the authenticated
session, never a browser-supplied user ID. It serves both “Log out” and “Revoke”.
The only additional POST is the personal-token mint action and its show-once result.
After success revalidate the list; for
this console browser, clear its cookie and go to the signed-out page. Show progress
and the 60-second limit for existing connections. No bulk logout, audit explorer,
search, online presence, or editable labels in v1.

## 5. Implementation order and files

| Slice                                     | Files/systems                                                                                                                              | Acceptance before moving on                                                                                                                                                                                 |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Provider and resource                  | `src/control-plane.ts`, `worker.ts`, `session.ts`, directory schema, SDK/fixtures                                                          | Real code + PKCE and refresh reach MCP at `/api` and RPC at `/api`; wrong audience/scope/project denied locally too; tagged admin Bearer works at `/api` and existing in-band fixtures use `/internal/rpc`. |
| 2. One browser implementation             | New `src/browser-auth.ts`, `src/browser-session.ts`; bindings; existing login/authorize routes; small Google identity adapter              | Two console browser contexts retain separate grants; server-side console exchange, parallel refresh, and callback replay have defined outcomes; logout ends local SSO.                                      |
| 3. Project hosts                          | Existing project ingress in `worker.ts`, account app links, trusted client provisioning                                                    | Docs and Voice use the same adapter, independently refresh, and cannot reach another project or receive the console cookie/token.                                                                           |
| 4. Activity, Sessions UI, personal tokens | New `src/oauth-sessions.ts`, `control-plane.sql`, `_auth/sessions.tsx`, account nav; common dispatch in `iterate-context.ts`               | Inventory, last use, personal-token mint/use/expiry, ownership, per-grant logout, live capability expiry, and cleanup failures work end to end.                                                             |
| 5. Kit and one board                      | `apps/kit` callback/installer/config image; ESPHome C++ component + Python codegen, partition/Wi-Fi import, build/checksum/catalog release | Browser-issued device grant survives reboot/refresh/OTA and is independently revocable.                                                                                                                     |
| 6. Remove old paths and prove preview     | `principal.ts`, old project-cookie/token doors and affected tests/docs; existing preview lanes                                             | No covered user flow falls back to legacy credentials; preview traces and state satisfy the test matrix.                                                                                                    |

Introduce the activity/revocation guard with slice 1; slice 4 completes its UI and
connection integration. Do not ship an intermediate slice that claims working logout
without its corresponding admission and live-connection checks.

## 6. End-to-end tests

Extend the existing `project-worker` Playwright and deployed Vitest lanes. Use real
provider code, KV/D1, redirects, cookies, and token endpoints. Mock only an upstream
identity provider in deterministic local tests; do not mint a provider grant inside
the test to bypass the flow being tested. Admin credentials set up fixtures and
test the explicit admin path; they must not bypass the user flow under test.

| Scenario                            | Concrete proof                                                                                                                                                                                                                                                                                                                                                                                                   |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Console on desktop and mobile       | Two browser contexts log in through the UI; each has a row; closing/reopening a tab reuses its session; logging out one preserves the other.                                                                                                                                                                                                                                                                     |
| Project-host SSO                    | Console → Docs → Voice across real origins; one human login, distinct grants and host-only cookies; direct visit to an app also works.                                                                                                                                                                                                                                                                           |
| Host and environment isolation      | Wrong app host, unknown project, forged Host/return URL, cross-site POST/WS, and preview token on production-like origin are rejected; no credentials appear in SSR output or forwarded cookies.                                                                                                                                                                                                                 |
| MCP client interoperability         | Automate discovery → CIMD → code + PKCE → actual MCP initialize/tool call → refresh, with DCR absent throughout. Assert CIMD support and public-client authentication are advertised, `registration_endpoint` is absent, and `/oauth/register` returns 404. Internal `createClient()` still works. Separately record manual preview smoke evidence and minimum supported versions for Cursor, Codex, and Claude. |
| Browser OAuth failures              | Invalid/missing state, mismatched issuer/callback, wrong verifier, used/expired code, denied consent, interrupted exchange, concurrent tabs, and parallel refresh cannot produce a mismatched or duplicated session.                                                                                                                                                                                             |
| Verified identity and registrations | Local fake OIDC server signs real test ID tokens; reject wrong signature/issuer/audience/nonce and unverified email. Concurrent first app visits leave one registration; callback replacement explicitly reauthorizes; no first-party `updateClient()` TTL regression.                                                                                                                                           |
| Permissions                         | Project A token cannot call project B; zero projects means zero; dropped `iterate` scope denies; client metadata cannot impersonate a first-party registration; membership removal affects existing sessions.                                                                                                                                                                                                    |
| Session inventory and activity      | Multiple grants for one client remain distinct; pagination works; activity advances after API/RPC use and stays unchanged for an idle client while the user views the page.                                                                                                                                                                                                                                      |
| Personal API tokens                 | Mint through the UI; token shown once with no refresh token, absent from reload/SSR; two mints remain independent. Use the actual bearer for MCP and RPC; assert issuing-user attribution, selected projects, current membership, last use and revoke. Reject forged actor/admin fields and direct browser consent for the internal client.                                                                      |
| Personal-token expiry               | Clock-controlled expiry denies HTTP and held capabilities; list reports Expired then cleans the grant through public helpers. Cleanup failure stays visible; non-expiring device grants are preserved. Personal-client refresh is refused; lost mint response never triggers a hidden remint.                                                                                                                    |
| Global admin token                  | Configured admin Bearer works at MCP `https://mcp.iterate2.com/` and Cap’n Web `/api`, with admin attribution; wrong/blank/old configured token gets 401 on new admissions. No user grant, activity row, refresh credential, or Sessions entry is created. In-band `/internal/rpc` still verifies the same secret; provider user tokens cannot become admin by setting actor text.                               |
| Per-session logout                  | Capture access/refresh tokens and hold a live RPC child/returned capability; log out that row; new use/refresh fails and the held capability stops within 60 seconds; other app/client/device grants work.                                                                                                                                                                                                       |
| Logout races and failures           | Revoke while refresh is paused, provider delete failure, concurrent double logout, a foreign grant ID, and D1 outage; no resurrection, dishonest success, or cross-user marker write. Prove marker precedence deterministically by leaving valid KV tokens in place while committing the marker, then test cleanup.                                                                                              |
| RPC through the provider            | Browser cookie → adapter → bearer middleware → real 101 → RPC call; also a native bearer upgrade with Origin. No Response reconstruction loses the WebSocket.                                                                                                                                                                                                                                                    |
| Kit provisioning                    | Exercise Kit-origin preflight and browser code exchange; capture/decode the exact generated image at the flash boundary; start a device simulator using only that image; refresh once immediately to catch the callback-TTL-key trap, call the API, and see its distinct row.                                                                                                                                    |
| Two devices and lifetime            | Two images yield two grants; refresh replacement is persisted; one device's logout preserves the other. Inspect `listUserGrants`: device `expiresAt` is absent, browser expiry is about 30 days, and refresh does not extend it. Clock-controlled local tests cover elapsed time; no claim to accelerate deployed KV's clock.                                                                                    |
| Hardware acceptance                 | Flash one supported ESP32/ESPHome board; test reboot, lost refresh response, power cut around NVS commit, offline recovery, OTA, reset and re-pair. Browser simulation alone is not the hardware proof.                                                                                                                                                                                                          |

Suggested files: replace covered cases in `specs/auth.spec.ts`; add focused
`specs/sessions.spec.ts`, `specs/kit-provisioning.spec.ts`, and
`e2e/oauth-lifecycle.e2e.test.ts`. Reuse the existing app fixture and OAuth/browser
helpers rather than building another harness. Fix the browser runner to default
to `localhost` for its secure-context cookie tests; it currently defaults to
`127.0.0.1` despite the auth spec's own warning. Preview is the HTTPS/cross-site proof.

Run from `packages/v3/project-worker` after implementation:

```bash
pnpm typecheck
pnpm build
pnpm test
pnpm spec
```

Repeat the focused scenarios against a disposable preview using the existing
`DEMO_BASE_URL`, `WORKER_BASE_URL`, and `PROJECT_HOSTNAME_BASE` configuration and
secret injection. Kit needs a matching preview origin and registered callback in
that harness. Follow repo formatting/lint checks. Interactive browser inspection
uses an isolated headless Playwriter session per the repository instructions.

Preview acceptance includes successful and refused requests in traces, correct
classification of expected OAuth outcomes, monotonic activity, bounded connection
termination, independent grants, and no unexplained refresh loops or surviving
authority. Record evidence with the implementation; this document claims no test
or deployment has run.

## 7. Complexity and lines of code

Estimates are **handwritten added or substantially replaced lines**, including
ordinary comments, excluding generated files, lockfiles, vendored provider code,
and these documents. They are planning ranges, not a claim that a smaller diff is
necessarily safer. Reuse existing UI, OAuth fixtures, D1 directory, and ingress.

| Work                                                                                                                   | Complexity  | Implementation LOC |
| ---------------------------------------------------------------------------------------------------------------------- | ----------- | -----------------: |
| Provider configuration, canonical routing, scope/project gate, `/api/session` and `/api/device-events` worker handlers | Medium      |            200–320 |
| Shared browser adapter, session DO, verified-login integration                                                         | Medium–high |            550–850 |
| Activity/revocation state, server functions, Sessions page, live lease                                                 | Medium      |            320–480 |
| Project-host client provisioning and ingress integration                                                               | Medium      |            150–250 |
| Personal-token issuance/expiry, mint UI, explicit admin context integration                                            | Low–medium  |            190–290 |
| Kit OAuth/config-image integration                                                                                     | Low–medium  |            180–300 |
| ESPHome component, partition/Wi-Fi/codegen/build integration, minimal HTTP operation                                   | Medium      |            500–850 |
| **Production implementation**                                                                                          |             |    **2,090–3,340** |
| E2E additions/replacements and focused failure tests                                                                   |             |    **1,550–2,400** |
| **Total handwritten change**                                                                                           |             |    **3,640–5,740** |

Expect roughly **200–350 obsolete lines removed** as custom signed project-session
credentials and covered old tests disappear; don't subtract those until measured.
The platform/browser portion, including personal/admin tokens, is about
**1,410–2,190 implementation lines**; Kit and
firmware account for the rest. Provider changes: **zero lines**.
Within those numbers, the Sessions page with the token form should be approximately
**160–260 lines**, plus its three small server functions; most of the activity row
is enforcement. The personal/admin-token addition accounts for **190–290 production
and 250–400 test lines** over the reviewed browser/device design.
These ranges incorporate Fable's independent estimate. Target the low end through
the accepted simplifications, while budgeting the full range for the complete proof.

The highest uncertainty is verified-login integration, refresh interruption recovery,
and revoking capabilities already passed to another peer. Resolve those in the
first browser/connection slices before committing to the low estimate. Hardware
bring-up may take more time than its code size suggests. A full Docs/Voice product
rewrite, multiple board ports, external-app resource servers, device authorization,
and migrating old production machine credentials are outside this estimate.

If the implementation grows, first remove duplicated browser flows, extra scope
taxonomies, configurable auth frameworks, and unnecessary UI features. Do not save
lines by accepting a bare email login, putting browser refresh tokens in frontend
storage, omitting refresh serialization, or claiming KV deletion closes sockets.

## Source anchors and review

- [Provider public helpers](https://github.com/cloudflare/workers-oauth-provider/blob/v0.10.3/src/oauth-provider.ts#L597-L688): client creation, grant listing/revocation, token inspection.
- [Provider protected handlers](https://github.com/cloudflare/workers-oauth-provider/blob/v0.10.3/README.md#protecting-routes): provider bearer/audience checks and app-owned permissions.
- [Provider grant replacement](https://github.com/cloudflare/workers-oauth-provider/blob/v0.10.3/src/oauth-provider.ts#L5296-L5317): concurrent authorizations require deliberate replacement policy.
- [Provider initial refresh expiry](https://github.com/cloudflare/workers-oauth-provider/blob/v0.10.3/src/oauth-provider.ts#L2621-L2654): absolute grant lifetime; device override is intentional.
- [Provider no-refresh grant storage](https://github.com/cloudflare/workers-oauth-provider/blob/v0.10.3/src/oauth-provider.ts#L4043-L4058): personal-token access expiry does not give its grant metadata a KV expiry.
- [Provider external-token hook](https://github.com/cloudflare/workers-oauth-provider/blob/v0.10.3/src/oauth-provider.ts#L3951-L3970): the existing admin bearer uses the supported hook and canonical audience.
- [Workers KV consistency](https://developers.cloudflare.com/kv/concepts/how-kv-works/#consistency): why session logout needs an application admission check.
- [TanStack Start server functions](https://tanstack.com/start/latest/docs/framework/react/guide/server-functions): existing server-only reads and mutations suffice for the UI.
- [Google OpenID Connect](https://developers.google.com/identity/openid-connect/openid-connect): upstream human verification, while Iterate keeps its own issuer and directory.
- [D1 primary and replicated reads](https://developers.cloudflare.com/d1/best-practices/read-replication/): ordinary binding reads remain on the primary; replica sessions need deliberate consistency handling.
- [Provider client update](https://github.com/cloudflare/workers-oauth-provider/blob/v0.10.3/src/oauth-provider.ts#L5624-L5629): the persistent-client expiry trap avoided by this plan.
- [Provider refresh callback validation](https://github.com/cloudflare/workers-oauth-provider/blob/v0.10.3/src/oauth-provider.ts#L2829-L2834): the refresh TTL key must be absent during refresh.
- [Cap'n Web call hook in the 0.12.2 version commit](https://github.com/iterate/capnweb/blob/f109ab0/src/rpc.ts#L464-L470): synchronous invocation is required to preserve call ordering.

Cross-checked by **Claude Fable 5.1**, invoked with `--effort xhigh`. The
[review and disposition](unified-oauth-implementation-review.md) record the source
findings, accepted reductions, corrected estimates, and suggestions not
adopted. The revised plan preserves the earlier independent-login decision.
