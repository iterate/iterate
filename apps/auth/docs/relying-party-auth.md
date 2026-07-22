# Relying-party authentication

`@iterate-com/auth/server` is the Worker-side client for an app that trusts
Iterate's OIDC provider. Its auth routes compose as an ordinary partial fetch:

```ts
const authResponse = await auth.fetch(request);
if (authResponse) return authResponse;
```

A response means auth owns the request (login, callback, logout, session, or
session-from-token).
`null` only means the request is not one of those routes; it does **not** mean
the application request is authenticated. The null path does not read the
request body.

## Complete Worker example

```ts
import { createIterateAuth, withAuthenticationResponseHeaders } from "@iterate-com/auth/server";

let auth: ReturnType<typeof createIterateAuth> | undefined;

function authFromEnv(env: Env) {
  return (auth ??= createIterateAuth({
    issuer: "https://auth.iterate.com/api/auth",
    clientId: env.AUTH_CLIENT_ID,
    clientSecret: env.AUTH_CLIENT_SECRET,
    redirectURI: "https://bookshop.example.com/api/iterate-auth/callback",
    resource: "https://bookshop.example.com",
  }));
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const auth = authFromEnv(env);
    const authResponse = await auth.fetch(request);
    if (authResponse) return authResponse;

    const authentication = await auth.authenticate({
      headers: request.headers,
    });
    const response =
      authentication.credential === null
        ? Response.redirect(new URL(`${auth.authHandlerBasePath}/login`, request.url).href)
        : Response.json({ user: authentication.identity });

    // Session verification may rotate the refresh token inside the session
    // cookie. Apply these headers even when the application response is a
    // redirect or an error.
    return withAuthenticationResponseHeaders(response, authentication.responseHeaders);
  },
};
```

Cache the auth object when configuration is stable so discovery, JWKS, and
refresh single-flight state survive across requests in the isolate.

Use the narrow methods when the route accepts exactly one credential kind:

- `authenticateSession()` returns the browser session and refresh headers;
- `authenticateBearer()` returns verified access-token claims;
- `authenticate()` tries the session first, then bearer, and returns one
  normalized identity.

First-party OS, Semaphore, `apps/streams-example-app`, and
[`apps/auth-example`](../../auth-example/src/worker.ts) all execute this same
`createIterateAuth()` implementation. TanStack middleware uses the same two
calls around `next()` and applies the emitted headers to `result.response`; see
[`apps/os/src/auth/middleware.ts`](../../os/src/auth/middleware.ts).

## Internal project workers

An internal app in a project's config repo does not configure an OAuth client.
It asks its project capability for the stronger project-member gate:

```ts
export class PrivateApp extends IterateWorkerEntrypoint {
  async fetch(request: Request): Promise<Response> {
    using itx = await this.env.ITX.get();
    const authResponse = await itx.auth.get({ policy: "project-member" }).fetch(request);
    if (authResponse) return authResponse;

    return new Response("private project app");
  }
}
```

This has the same body-safe partial-fetch composition, but deliberately
different null semantics: here `null` means the project-member policy passed.
The platform owns the origin-bound project cookie, login callback, membership
check, and denial response. It is not the OIDC relying-party implementation
used by OS.

For an app-defined Cap'n Web API, exchange the exact-origin project cookie for
an actor and return an app-specific session capability (the seeded template's
member-gated todo app shows the partial-fetch half live).
Cookie authentication performed inside an already-open RPC transport must not
refresh: it cannot return the rotated `Set-Cookie`. OS enforces that with the
narrow session method and `refresh: "never"`; non-browser clients use an
explicit bearer, operator, or admin credential.

## Guarantees and caller obligations

The auth library guarantees:

- A null partial-fetch result never consumes the request body.
- Relying-party `fetch()` is routing, never an authorization decision.
- A request's session is checked before its bearer token.
- WebSocket upgrades never rotate cookies.

The relying-party worker must:

- Copy every authentication response header to the final HTTP response.
- Pass `refresh: "never"` when authenticating inside an RPC transport that
  cannot return `Set-Cookie`.
- Accept ambient cookie authority only on its exact origin and give
  application code an attenuated capability rather than raw authority.
