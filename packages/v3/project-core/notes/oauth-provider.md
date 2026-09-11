# OAuth provider: minimal email-entry MCP demo

**Decision:** use `@cloudflare/workers-oauth-provider` as the OAuth 2.1
authorization-server and `/mcp` resource-server wrapper. Do not use Cloudflare
Access for this demo. Keep browser login/session and project authorization in a
small outer application seam; the provider is deliberately not an identity
provider.

## Current facts

The current published package and upstream `main` are **0.10.3** (checked
2026-09-05). The local checkout at
`/Users/jonastemplestein/src/github.com/cloudflare/workers-oauth-provider` is
the older 0.8.3, so it is useful background but not the API authority for this
proposal. The package protects HTTP/MCP routes and implements OAuth flows; its
application-owned `defaultHandler` must authenticate the browser user and
collect consent. [Current manifest](https://github.com/cloudflare/workers-oauth-provider/blob/main/package.json),
[authorization endpoint contract](https://github.com/cloudflare/workers-oauth-provider/blob/main/README.md#authorization-endpoint).

There are two distinct credentials:

- A **browser session cookie** is ours. The package neither creates nor checks
  it. It identifies the human only while rendering `/login` and `/authorize`.
- An **OAuth access/refresh token** is the provider's. It is presented as a
  bearer token only to the protected `/mcp` route; successful validation makes
  the granted application `props` available as `ctx.props`.

`OAUTH_KV` is a required binding for OAuth client registrations, grants and
token data; it is not a browser-session store. The provider hashes bearer
secrets and encrypts `props`, but `userId` and grant metadata remain storage
data, so neither should contain secret material. [KV binding and route
example](https://github.com/cloudflare/workers-oauth-provider/blob/main/README.md#quick-start),
[storage schema](https://github.com/cloudflare/workers-oauth-provider/blob/main/storage-schema.md).

## Small outer seam

Put a single app-owned `IdentitySession` boundary around the provider. It owns
the email-entry demo, a signed opaque `__Host-` session cookie, CSRF validation,
and conversion from a selected project to OAuth `props`. The MCP handler owns
the final per-tool authorization; it must not treat a display email as a grant.

```ts
type McpProps = { actorId: string; projectId: string; scopes: string[] };

interface IdentitySession {
  read(request: Request): Promise<{ actorId: string; email: string } | null>;
  begin(email: string): Promise<{ value: string; actorId: string }>;
  verifyCsrf(request: Request): Promise<void>;
}

const resource = new URL("/mcp", publicOrigin).href;
```

For this isolated demo, `POST /login` accepts a syntactically valid email and
creates an opaque signed session. That proves only that someone entered a
string: it is **not** email ownership, membership, privacy, or a safe route to
secrets/egress. Make that mode preview-only (an explicit `DEMO_EMAIL_ENTRY`
setting) and reject it in production configuration. A real mode replaces only
`begin()` with verified email/SSO; it does not change the OAuth route.

The login and consent forms need app-level CSRF protection. Use a one-use,
short-lived form token tied to the current session and an `__Host-`;
`Secure; HttpOnly; SameSite=Lax; Path=/` cookie; rotate the session identifier
on login. Cloudflare's current MCP guidance gives this same one-time-CSRF
shape. [CSRF guidance](https://developers.cloudflare.com/agents/model-context-protocol/guides/securing-mcp-server/#csrf-protection).

## Minimal provider shape

This is the smallest meaningful arrangement: one canonical deployed origin,
one exact resource URI, no external-token fallback, and a normal consent
screen. `toMcpProps()` is the one product-specific seam: it must derive
project/scopes from a durable app grant, never from client request parameters.

```ts
import {
  AuthorizationError,
  OAuthProvider,
  type AuthRequest,
  type OAuthHelpers,
} from "@cloudflare/workers-oauth-provider";
import { WorkerEntrypoint } from "cloudflare:workers";

interface Env {
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: OAuthHelpers;
}

const sessions = (env: Env): IdentitySession => outerSessions(env);

class Mcp extends WorkerEntrypoint<Env, McpProps> {
  fetch(request: Request) {
    if (new URL(request.url).pathname !== "/mcp") return new Response("Not found", { status: 404 });
    return dispatchMcp(request, this.ctx.props); // re-check tool/project scope
  }
}

const defaultHandler: ExportedHandler<Env> = {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/login" && request.method === "POST") {
      await sessions(env).verifyCsrf(request);
      const email = await readAndValidateEmail(request);
      const session = await sessions(env).begin(email);
      return resumeValidatedAuthorize(session); // stores/recovers only validated continuation
    }
    if (url.pathname !== "/authorize") return new Response("Not found", { status: 404 });

    let auth: AuthRequest;
    try {
      auth = await env.OAUTH_PROVIDER.parseAuthRequest(request);
    } catch (error) {
      if (!(error instanceof AuthorizationError)) throw error;
      return error.redirectUri
        ? safeOAuthErrorRedirect(error) // uses only error.redirectUri/state/issuer
        : new Response(error.description, { status: 400 });
    }
    const identity = await sessions(env).read(request);
    if (!identity) return renderLoginForValidatedAuthorize(auth);
    if (request.method === "GET") return renderConsent(auth, identity);
    await sessions(env).verifyCsrf(request);
    const props = await toMcpProps(identity, auth); // durable project grant + chosen scopes
    const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
      request: auth,
      userId: props.actorId,
      scope: props.scopes,
      props,
    });
    return Response.redirect(redirectTo, 302);
  },
};

export default new OAuthProvider<Env>({
  apiRoute: "/mcp",
  apiHandler: Mcp,
  defaultHandler,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/oauth/token",
  scopesSupported: ["mcp:read"],
  resourceMetadata: {
    resource,
    authorization_servers: [publicOrigin],
    scopes_supported: ["mcp:read"],
    resource_name: "Project Core MCP",
  },
  allowPlainPKCE: false,
  // Enable one of CIMD or DCR only when a target MCP client requires it.
});
```

`parseAuthRequest()` validates the client, exact redirect URI, response type,
resource and PKCE policy. It throws `AuthorizationError`; redirect only when
its validated `redirectUri` is present. `completeAuthorization()` revalidates
before writing the grant. This is the expected-error boundary: rethrow any
other error rather than transforming a defect into an OAuth response.
[Current quick start](https://github.com/cloudflare/workers-oauth-provider/blob/main/README.md#quick-start),
[typed authorization failures](https://github.com/cloudflare/workers-oauth-provider/blob/main/README.md#authorization-endpoint).

Public clients use authorization-code + **S256 PKCE**. Current 0.10.3 defaults
`allowPlainPKCE` to false; setting it explicitly guards against a future
configuration drift. Do not enable implicit flow. [PKCE lifecycle](https://github.com/cloudflare/workers-oauth-provider/blob/main/README.md#pkce-and-token-lifecycle).

## Token audience and client registration

Set `resourceMetadata.resource` to the exact public `https://host/mcp` URI.
The provider requires an authorization request's configured resource to match
exactly, and rejects a stored token not bound to that configured resource. Its
general audience matcher permits a path-boundary prefix, so the handler above
also rejects every path other than exactly `/mcp`. Together those checks prevent
a token minted for another resource, or for a `/mcp/*` route, from reaching
this MCP endpoint.
[Current resource checks](https://github.com/cloudflare/workers-oauth-provider/blob/main/src/oauth-provider.ts#L5186-L5195),
[protected-route checks](https://github.com/cloudflare/workers-oauth-provider/blob/main/src/oauth-provider.ts#L3879-L3914).

For an isolated preview, make `publicOrigin` an explicit preview origin and
set its exact `/mcp` URI; do not derive it from the incoming `Host` header.
For localhost development, construct a separate provider config for the exact
localhost origin and do not accept a public token there (or vice versa). OAuth
client redirect URIs are separately exact-match validated.

Start with a pre-registered client if the chosen MCP client permits it. Enable
Client ID Metadata Documents (CIMD) only when needed: it requires
`clientIdMetadataDocumentEnabled: true`, `global_fetch_strictly_public`, and a
new-enough compatibility date for fetch cache controls. Dynamic Client
Registration is an optional compatibility endpoint, not a requirement for the
demo. [CIMD requirements](https://github.com/cloudflare/workers-oauth-provider/blob/main/README.md#client-id-metadata-documents),
[DCR options](https://github.com/cloudflare/workers-oauth-provider/blob/main/README.md#dynamic-client-registration).

```jsonc
// wrangler.jsonc: no credentials in this file
{
  "kv_namespaces": [{ "binding": "OAUTH_KV", "id": "<isolated-preview-kv-id>" }],
  // Add global_fetch_strictly_public only with CIMD.
}
```

Cloudflare KV is eventually consistent across locations and concurrent writes
to one key are last-write-wins, so do not promise instantaneous global token
revocation or use KV as the sole single-use security decision for the outer
session/consent store. A Durable Object is the appropriate outer seam if the
demo grows a hard single-use or immediate-revocation requirement.
[KV consistency](https://developers.cloudflare.com/kv/concepts/how-kv-works/),
[KV write semantics](https://developers.cloudflare.com/kv/api/write-key-value-pairs/).

## `resolveExternalToken`: deliberately absent

Leave `resolveExternalToken` unset. It is only called after internal KV lookup
fails and is an advanced bridge for external OAuth tokens/API keys/PATs. If
later required, return `null` for an invalid credential, return derived
non-secret props plus this exact `resource` as its audience, and throw only
the exported `ExternalTokenError` for intentional OAuth-shaped failures;
ordinary exceptions remain defects. It is not a substitute for provider-issued
MCP tokens, and forwarding such a received upstream key would be token
passthrough rather than MCP-conformant authorization.
[External-token contract](https://github.com/cloudflare/workers-oauth-provider/blob/main/docs/advanced-configuration.md#external-token-resolution),
[error classification in source](https://github.com/cloudflare/workers-oauth-provider/blob/main/src/oauth-provider.ts#L486-L498).

## Recommendation

For the PoC, deploy one new isolated preview worker containing the outer
session/consent seam and this provider, with a new `OAUTH_KV` namespace. Expose
OAuth only for `/mcp`; keep existing anonymous/bootstrap and control-plane APIs
out of the experiment. The one integration point into project-core is
`dispatchMcp(request, props)`: it accepts a verified `{ actorId, projectId,
scopes }`, then still checks each operation's capability. That keeps demo
email entry from accidentally becoming authority over projects, secrets,
egress, or existing deployments.
