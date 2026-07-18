# Relying-party authentication

`@iterate-com/auth/server` is the Worker-side client for an application that
trusts Iterate's OIDC provider. It deliberately has two small operations:

```ts
const authResponse = await auth.fetch(request);
if (authResponse) return authResponse;

const authentication = await auth.authenticate({ headers: request.headers });
```

The first operation composes HTTP handlers. The second resolves identity for
the application route that remains. Keeping those jobs explicit is what lets a
Worker keep the original `Request`, propagate rotated cookies, and decide which
capability an authenticated user receives.

## The complete contract

| Operation                                              | Result                                    | Meaning of `null`                                                                                         |
| ------------------------------------------------------ | ----------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `auth.fetch(request)`                                  | `Promise<Response \| null>`               | This is not an auth-owned route. The request has not been consumed.                                       |
| `auth.authenticate({ headers })`                       | a session, bearer token, or no credential | `credential: null` means no accepted identity was proven.                                                 |
| `withAuthenticationResponseHeaders(response, headers)` | `Response`                                | Copies every auth response header, including separate `Set-Cookie` values.                                |
| `itx.auth.get(policy).fetch(request)`                  | `Promise<Response \| null>`               | The project policy passed. This stronger project gate owns login, callback, logout, and denial responses. |

The two `fetch` methods intentionally use the same ordinary partial-fetch
protocol: return a response when the component owns the request, otherwise
return `null` without consuming it. Their null results carry different facts:

- relying-party `auth.fetch()` only says “not an auth protocol route”;
- project `itx.auth.get(policy).fetch()` says “the policy passed; continue the
  protected app.”

That distinction matters. A general relying party still needs the proven
identity for authorization, rendering, and capability construction.

## A complete Worker

This is the framework-free shape. Cache the auth object when configuration is
stable so its discovery and JWKS caches survive across requests in an isolate.

```ts
import { createIterateAuth, withAuthenticationResponseHeaders } from "@iterate-com/auth/server";

type Env = {
  AUTH_CLIENT_ID: string;
  AUTH_CLIENT_SECRET: string;
};

let cachedAuth: ReturnType<typeof createIterateAuth> | undefined;

function authFromEnv(env: Env) {
  return (cachedAuth ??= createIterateAuth({
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

    // Login, callback, logout, and session routes belong to auth.
    const authResponse = await auth.fetch(request);
    if (authResponse) return authResponse;

    // Application routes choose which credentials they accept.
    const authentication = await auth.authenticate({
      headers: request.headers,
      includeUserInfo: false,
    });

    let response: Response;
    if (authentication.credential === null) {
      const login = new URL(`${auth.authHandlerBasePath}/login`, request.url);
      login.searchParams.set("return_to", request.url);
      response = Response.redirect(login);
    } else {
      response = Response.json({
        userId: authentication.identity.userId,
        email: authentication.identity.email,
        isAdmin: authentication.identity.isAdmin,
      });
    }

    // Authentication may have rotated the refresh token. This is part of the
    // auth transaction, including when the application returns an error.
    return withAuthenticationResponseHeaders(response, authentication.responseHeaders);
  },
};
```

`accept` can narrow authentication to `"session"`, `"bearer"`, or the default
`"session-or-bearer"`. When both are present, the browser session wins. Every
accepted credential carries the same normalized `identity` (`userId`, email,
admin/role status, session ID, organizations, and projects); the discriminated
variant also retains the full session or verified access-token claims when an
application needs credential-specific detail.

## TanStack Start middleware

The same partial fetch fits directly at the top of request middleware. The
middleware puts the discriminated authentication result in route context and
wraps the eventual response so a refresh cookie is never lost.

```ts
const authMiddleware = createMiddleware({ type: "request" }).server(async ({ request, next }) => {
  const authResponse = await auth.fetch(request);
  if (authResponse) return authResponse;

  const authentication = await auth.authenticate({
    headers: request.headers,
    includeUserInfo: false,
  });
  const result = await next({ context: { authentication } });
  const response = withAuthenticationResponseHeaders(
    result.response,
    authentication.responseHeaders,
  );
  return response === result.response ? result : { ...result, response };
});
```

Do not extract `Set-Cookie` with `headers.get("set-cookie")`. A response can
carry several cookies, and joining them changes their meaning. The helper uses
`Headers.getSetCookie()` and appends each value separately.

## OS: one resolver for HTTP and Cap'n Web

`apps/os` has additional credential lanes: deployment admin secrets,
origin-bound operator grants, Iterate sessions, and bearer access tokens. All
of those precedence and authority decisions live in
`resolveOsRequestAuth()` (`apps/os/src/auth/request-auth.ts`). The TanStack
middleware and the unauthenticated Cap'n Web root both call that resolver.

The HTTP lane allows an anonymous result and can return refresh headers:

```ts
const authResponse = (await auth?.fetch(request)) ?? null;
if (authResponse) return authResponse;

const resolved = await resolveOsRequestAuth({
  config,
  credentials: { type: "from-request" },
  iterateAuth: auth,
  request,
});
```

The Cap'n Web lane supplies explicit credentials and requires capability
authority:

```ts
async authenticate(credentials: ItxAuthCredentials) {
  const resolved = await resolveOsRequestAuth({
    config,
    credentials,
    iterateAuth: auth,
    request,
  });
  return new SessionRpcTarget({ auth: resolved.itxAuth, config, ctx });
}
```

For `{ type: "from-server-cookie" }`, the resolver requires exact-origin
ambient cookies and authenticates with `refresh: "never"`. An in-band RPC
method cannot attach `Set-Cookie` to the already-open outer response; rotating
there would spend a refresh token the browser can never receive. An expired
cookie must first be refreshed by a normal HTTP navigation and then reconnect.

## Project workers: enforcement as a partial fetch

A project app does not configure its own Iterate OAuth client for an internal
project-member page. It asks its project-scoped capability host for a policy
gate:

```ts
export class InternalApp extends IterateWorkerEntrypoint {
  async fetch(request: Request): Promise<Response> {
    using itx = await this.env.ITX.get();
    const authResponse = await itx.auth.get({ policy: "project-member" }).fetch(request);
    if (authResponse) return authResponse;

    // null means the member policy passed. The exact original body remains.
    if (request.method === "POST") {
      return new Response(await request.text());
    }
    return new Response("private project app");
  }
}
```

The gate owns the login form, callback, logout, host-only cookie, membership
re-check, and denial response. It reads request metadata in the common case.
Only its exact callback POST consumes the body, and that path always returns a
response. There is no `request.clone()` in the application or gate protocol.

For an app API, keep the unauthenticated WebSocket root deliberately weak and
exchange its exact-origin cookie for an app-specific capability:

```ts
class PublicApi extends RpcTarget {
  constructor(
    private readonly itxBinding: ItxBinding,
    private readonly request: Request,
  ) {
    super();
  }

  async authenticate(credentials: ProjectAuthCredentials) {
    using itx = await this.itxBinding.get();
    const actor = await itx.auth
      .get({ policy: "project-member" })
      .authenticate(this.request, credentials);
    return new BookShopSession(actor);
  }
}
```

The browser receives `BookShopSession`, not the full project `itx`. Methods
reachable from that session are the app's authorization surface. The seeded
config-repo `InternalApp` is a working example with `LiveState` over the same
Cap'n Web primitives used by first-party OS.

## Why there is no universal enforcing `fetch()`

An exact `Response | null` partial fetch cannot also return all of the state OS
needs after a successful check:

1. `null` has nowhere to carry the authenticated principal that route code
   uses to construct attenuated capabilities.
2. Session verification may rotate a cookie. `null` has nowhere to carry the
   resulting `Set-Cookie` to the final response.
3. Hidden request mutation, a `WeakMap`, or async-local state would make the
   apparently pure null path depend on isolate-local side effects and request
   identity.
4. Calling `authenticate()` again after a gate returns null would duplicate
   JWT verification and can duplicate refresh work.

Project policy fetch can use the stronger contract because its host retains
the actor and the app only needs a yes/no enforcement result for normal HTTP
routes. General apps and OS need the identity as a value, so they use the same
partial-fetch composition protocol followed by one explicit authentication
result. Cap'n Web then turns that result into a capability instead of exposing
raw credentials downstream.

## Security invariants

- A null partial-fetch result never consumes the request body.
- Authentication runs once per request path; there is no session-then-bearer
  duplication in callers.
- Every authentication response header reaches the final HTTP response.
- WebSocket and in-band RPC authentication never rotates a cookie.
- Ambient cookie authority is exact-origin; non-browser clients use explicit
  bearer, operator, or admin credentials.
- Applications vend app-specific capabilities, not ambient project authority.
