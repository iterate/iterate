# Unified OAuth and the issuer app

Implementation snapshot, 2026-09-10. Clean-room deployment: `os.iterate2.com`,
`mcp.iterate2.com`, `*.iterate2.app`; independent example: `notes.iterate2.com`.

## One authenticated session model

The Cloudflare OAuth provider owns authorization codes, PKCE, access tokens,
refresh tokens and grants. Both public `/api` Cap’n Web and MCP run the same
provider gate, then derive one verified authorization: principal, membership
reach, project ceiling, scopes and grant identity. A supplied bearer can also be
the configured operator secret. Legacy project credentials are not public API
credentials. `/internal/rpc` remains an explicit operator/test gate.

Each app runs the same `appAuth` adapter and `BrowserSession` Durable Object.
The browser holds only an opaque HttpOnly cookie; the DO holds tokens and makes
public HTTP token exchanges. `/api` proxies those tokens through ordinary
admission. Same-origin checks protect cookie-backed API calls and logout.
Authenticated TanStack routes use one shared browser client and Cap’n Web socket.
The console and independently hosted Notes dashboard import the same component
and loader. Project ingress is independent of the fixed console routes.

## The issuer is also an app

Google proves identity to the issuer; Google credentials never become Iterate
API credentials. After checking state, PKCE, nonce, signature, stable subject and
verified email, the callback runs `startIssuerSession`: ordinary app-session
begin, server-approved code, ordinary public token exchange. Its grant has
`kind: issuer`; it is the issuer's sole browser identity and appears in the same
session inventory. The local/admin fixture calls the same verified-login tail.

A signed ten-minute Google flow cookie is temporary correlation state, not a
signed-in identity. A separate stateless identity cookie no longer exists.
An explicit login page prevents a revoked session from silently recreating itself
through an existing Google browser login.

Version 2 grant kinds are `issuer`, `app`, and `personal`. Only verified sign-in
can mint `issuer`. Public consent always mints `app`, even when the requesting
client copies the console's CIMD ID or asks for account scope. PAT issuance mints
`personal`, grants only selected reachable projects and refuses refresh.

## First consent and capabilities

The client-only `/authorize` page authenticates with the shared app SDK.
An issuer session alone receives `session.consent.describe/approve`. Organization
creation and project creation use the ordinary `Session` capabilities, including
explicit organization selection. The original client's OAuth query remains in
the URL throughout onboarding; approval revalidates it and current memberships.
Organization and owner creation is one D1 transaction. Project creation is
idempotent within its owning organization and refuses foreign ownership.

Project selection is a ceiling intersected with live membership. `iterate`
grants project operations; explicit `account` permission adds session inventory,
revocation and PAT issuance bounded by the app's project reach. Any clone may ask
for this permission through consent. Account scope does not grant issuer consent
or future platform-admin powers. Project-host clients are constrained to their
host's project by the authorization server.

The [Cloudflare consent research](cloudflare-oauth-consent-and-project-permissions.md)
covers richer project/operation scopes. They are not enforced or advertised yet;
adding a checkbox without enforcing it at context capability construction would
misrepresent delegated authority.

## Revocation and partial work

Primary D1 revocation markers deny subsequent admission before provider KV
cleanup. Live sockets renew every thirty seconds with a sixty-second hard bound;
all frames, including forwarded native capabilities, share that lease. Consent
approval and PAT minting check current D1 authority at method admission, so they
cannot extend a revoked credential by spending that lease. Work admitted before
a concurrent revocation can finish.

Pending browser sessions and provider authorization-code grants expire after ten
minutes. Active grants and browser sessions have a thirty-day absolute limit.
Failed logout retains the local session and reports failure. Failed provider
cleanup retains a durable, visible marker for retry. No second grant ledger or
parent-grant graph exists.

## Impersonation is deferred

Keep grant ownership, effective membership reach and audit attribution distinct.
Membership reads follow `reach.userId`, inventory follows `grant.userId`, and
context event attribution follows the verified principal. The operator test
fixture's `as` option is not the product impersonation model.

A future implementation should establish an explicit acting-as admission so
reloads, ingress, MCP and socket renewal all agree on the effective user. It will
need a real admin-role check, visible mode indication and explicit decisions
about writes and credential-management capabilities. No speculative fields,
roles or impersonation UI were added in this implementation.
