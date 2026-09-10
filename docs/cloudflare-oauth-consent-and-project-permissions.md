# Cloudflare OAuth consent and Iterate project permissions

Research date: 2026-09-10. This compares Cloudflare's dashboard OAuth product
with the separate `@cloudflare/workers-oauth-provider` library, then applies
the result to `packages/v3/project-worker`.

## Answer

Cloudflare now has both requested parts of the consent experience:

1. the user selects the Cloudflare accounts an application may access; and
2. the user can decline individual _optional_ OAuth permissions.

They are two independent dimensions: an account/resource ceiling and one set
of OAuth scopes for the authorization. Cloudflare's public documentation does
**not** describe a UI or grant model in which a user selects a different scope
set for account A than for account B. It consistently describes selecting
accounts, then inspecting or editing the application's requested permissions;
optional scopes are configured on the OAuth client and evaluated against the
particular authorization request. The supported conclusion is therefore a
global selected-scope set applied to every selected account, plus an account
allowlist. This is an inference from the public model, not a claim about an
undocumented Cloudflare storage schema.

For Iterate, use that same first model:

```text
OAuth grant = { subject, client, grantedScopes, projectCeiling, expiry, grantId }
projectCeiling = all-member-projects | explicit project IDs
```

`projectCeiling` answers _which projects_; `grantedScopes` answers _which
capability families_. Do not encode project IDs as OAuth scope strings. Add a
per-project permission map only when a real need requires "read Project A,
write Project B".

## Current Cloudflare UX and dates

- **2026-04-14 — account selection and management.** Cloudflare announced
  account-by-account authorization, an All accounts option, permission list,
  account checkboxes, and Connected Applications management. [Changelog: improved
  consent and management](https://developers.cloudflare.com/changelog/post/2026-04-14-oauth-consent-and-revoke/)
- **2026-06-03 — self-managed OAuth clients.** App owners can create their own
  clients and select the limited scopes an app requests. [Changelog:
  self-managed OAuth clients](https://developers.cloudflare.com/changelog/post/2026-06-03-public-oauth-clients/)
- **2026-08-20 — optional scopes GA.** Client owners mark scopes required or
  optional. Required scopes cannot be declined; optional scopes can. Cloudflare
  says the decision is evaluated against the scope set requested in that
  authorization flow and defaults to granting all requested scopes. [Blog:
  task-based OAuth consent](https://blog.cloudflare.com/task-based-oauth-consent/)
- **2026-08-22 — Wrangler and Cloudflare API MCP.** The permission editor was
  enabled for both. The official post includes screenshots of the
  [consent dialog and editor](https://developers.cloudflare.com/changelog/post/2026-08-22-wrangler-mcp-optional-oauth-scopes/).

The current authorization documentation makes the intended sequence explicit:
select account(s), then see requested scopes; users may decline optional
permissions. The editor supports individual and category selection plus Read
only and Full access shortcuts. It does not say a scope toggle belongs to an
individual selected account. [Authorizing an
application](https://developers.cloudflare.com/fundamentals/oauth/authorizing-an-application/)

Cloudflare client configuration has a `scopes` set and an `optional_scopes`
subset. OAuth scope names match Cloudflare API-token permission names. [Create
an OAuth client](https://developers.cloudflare.com/fundamentals/oauth/create-an-oauth-client/)

## Scope shape for Iterate

Scopes should be few, stable product verbs, not a mirror of the itx tree:

| Scope           | Authority                                                                 |
| --------------- | ------------------------------------------------------------------------- |
| `project:read`  | Explicit read-only project capabilities.                                  |
| `project:write` | Ordinary project mutations and agent work.                                |
| `project:admin` | Project credentials/configuration that can delegate or broaden authority. |
| `account`       | Manage the user's Iterate OAuth grants and personal API tokens.           |

`project:write` should not imply `project:admin`, token minting, or API-key
rotation. The present code already separates `mintToken` and `rotateApiKey` as
project doors on `IterateContext`; retain that separation. Do not expose a
checkbox for an operation until the server can actually attenuate it.

Today, the repository's scopes are just `iterate` and `account`, and
`iterate` effectively allows all itx expressions once a project passes the
reach check. [`oauth-scopes.ts`](../packages/v3/project-worker/src/oauth-scopes.ts)

## Dashboard OAuth versus the Workers library

`@cloudflare/workers-oauth-provider` is a framework for an OAuth authorization
server in a Worker. It does not render Cloudflare dashboard UI or provide
Cloudflare-account selection. The application must authenticate the user,
render consent, and decide which scopes to grant. The provider validates the
authorization request, client, redirect URI, resource indicators, and PKCE;
the application calls `completeAuthorization({ scope, props })`. [Provider
README at pinned v0.10.3](https://github.com/cloudflare/workers-oauth-provider/blob/v0.10.3/README.md)

This repository pins **0.10.3**, released **2026-08-10**. At that version the
provider encrypts application-defined `props` into the grant/token and places
them in the protected handler's `ctx.props`; it stores one grant scope array;
and it permits token/refresh downscoping only within the grant's scope ceiling.
The provider deliberately leaves application permissions, tenancy, and consent
UI to the Worker. [v0.10.3 type/source
surface](https://github.com/cloudflare/workers-oauth-provider/blob/v0.10.3/src/oauth-provider.ts),
[v0.10.3 release](https://github.com/cloudflare/workers-oauth-provider/releases/tag/v0.10.3)

The current implementation uses the intended seam: `approveConsent` intersects
the selected IDs with the signed-in user's directory projects and places them
in provider props; `authorizationOf` parses those trusted props into a project
`Reach`; the Start consent route renders project checkboxes.
[`control-plane.ts`](../packages/v3/project-worker/src/control-plane.ts),
[`oauth.ts`](../packages/v3/project-worker/src/oauth.ts), and
[`routes/authorize.tsx`](../packages/v3/project-worker/src/routes/authorize.tsx)

## Carrying grants into `IterateContext`

The grant must be immutable, server-derived context at the one credential
admission point:

```text
verified bearer
  -> provider decrypts props into ctx.props
  -> authorizationOf validates schema, expiry, and revocation
  -> SessionAuthority { principal, projectCeiling, grantedScopes, grantId }
  -> projects.get(project) checks projectCeiling
  -> context factory vends only scope-authorized facets
```

Never take scopes, project IDs, a principal, or `authorization_details` from
an MCP argument, Cap'n Web argument, or request header as authority.
`IterateContext.invoke()` already strips any inbound principal header and
stamps the verified principal. Grant/facet information needs the same rule.
[`iterate-context.ts`](../packages/v3/project-worker/src/iterate-context.ts)

The project ceiling should be checked _before_ issuing the project context,
as `ProjectCollection.get()` already does. Method permissions require real
attenuation: have the context factory vend only the permitted
facets/capabilities. A central string-prefix ACL on arbitrary itx expressions
will drift with rewrite rules and newly added methods. Capability possession is
the correct enforcement point; retain the verified principal in the DO call for
attribution and retain grant ID/scopes for audit.

At present MCP checks `Reach` before `DO.invokeAs(principal, expression)`, but
passes no scope/facet authority into the invocation. Adding OAuth scope names
or consent checkboxes would therefore be cosmetic until this attenuation
exists. [`mcp.ts`](../packages/v3/project-worker/src/mcp.ts)

## First-consent organization/project creation

The requested first-consent flow can create an organization and project without
granting the MCP client continuing project-creation authority:

1. Authenticate the person in the issuer SPA.
2. Use the same-origin, browser-authenticated Cap'n Web session to create the
   organization (if needed) and project.
3. Complete OAuth with an explicit ceiling containing that newly created
   project ID and the chosen global scopes.
4. Redirect the client with a token that can use that project, but cannot
   create another.

This is better than translating no projects into an implicit all-current-and-
future-project grant. In the existing code, `projects: null` intentionally
becomes membership-derived expanding reach, while an explicit ID set is fixed.
[`control-plane.ts`](../packages/v3/project-worker/src/control-plane.ts) and
[`directory.ts`](../packages/v3/project-worker/src/directory.ts)

## Standards boundary

RFC 8707 `resource` identifies the protected API audience. It can name a
tenant-specific URI, but it does not define project selection or per-project
permissions; multiple audiences are discouraged. [RFC
8707](https://www.rfc-editor.org/rfc/rfc8707.html)

RFC 9396 Rich Authorization Requests can express structured resource-specific
rights and requires approved details to reach the resource server. It is the
standards-shaped future option for a per-project matrix such as
`{ type: "iterate_project", project, actions }`. It is not currently parsed by
`workers-oauth-provider` 0.10.3; its experimental enterprise path fails closed
for `authorization_details`. Do not advertise RAR until Iterate parses,
validates, persists, returns, and enforces typed details end to end. [RFC
9396](https://www.rfc-editor.org/rfc/rfc9396.html), [provider advanced
configuration](https://github.com/cloudflare/workers-oauth-provider/blob/v0.10.3/docs/advanced-configuration.md)

## Recommended decisions and tests

- Adopt Cloudflare's two-axis consent shape now: a project checkbox ceiling
  plus globally selected optional scopes.
- Make all-current-and-future-project access explicit and visually distinct
  from selected projects.
- Decide which itx capability families are read-only, ordinary write, and
  delegation/admin before exposing `project:*` selection.
- Add a first-consent e2e: new identity -> create org/project in consent SPA
  -> approve explicit fixed grant -> MCP token lists and uses that project ->
  second project is refused. Also prove forged header/request scopes cannot
  widen the resulting context.
