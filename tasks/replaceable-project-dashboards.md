---
state: backlog
priority: medium
size: large
dependsOn: []
tags: [os, remote-apps, architecture, auth, capnweb]
---

# Make project dashboards replaceable remote apps

This is an architectural goal and investigation, not an accepted implementation
specification.

This note records the design discussion around the Tasks app, project-host
authentication, CDN-served or externally hosted frontends, full-stack TanStack
Start apps, and a possible Cap'n Web bridge. Its main question is:

> Can OS remain the identity and capability control plane while a project
> dashboard is replaceable code, deployed independently and perhaps hosted by a
> trusted third party?

## Conclusion

Yes. The direction is not unusual or inherently insecure. It combines several
established patterns:

- an **identity-aware proxy** authenticates the browser and supplies an
  app-specific identity assertion to an upstream application;
- a **backend-for-frontend (BFF)** keeps transferable credentials out of browser
  JavaScript and forwards authenticated API operations;
- an **installable app** has one platform identity but many project
  installations, rather than one OAuth client per project;
- an **object-capability connection** can hand an application an attenuated ITX
  capability instead of a bearer secret.

The important qualification is that an alternative dashboard is not “just a
renderer” from a security perspective. Code which can issue ITX calls can read or
mutate whatever its capability permits. Installing a third-party dashboard is a
real, continuing trust decision, especially if the publisher can update the
served code without project-owner review.

The recommended shape is:

1. Keep authentication, project resolution, authorization, ITX, auditing, and
   revocation in OS.
2. Make the project UI a replaceable app behind a stable project origin.
3. Give browser sessions a short-lived, project- and app-scoped session without
   exposing the primary `auth.iterate.com` session.
4. Give background work a separate app-installation identity, not a captured
   user session.
5. Prefer an HttpOnly same-origin cookie plus BFF/capability API for browsers.
   A JavaScript-visible token for direct calls to `os.iterate.com` is possible,
   but should be an explicit lower-security mode.
6. Support both a pure SPA/static renderer and a full-stack application. They
   need different API routing, but they do not need different identity systems.
7. Keep `fetch` fetch-shaped. Bind configuration and capabilities before calling
   `fetch(request)`; do not invent `fetch(request, appContext)`.

The current Tasks design is already a working version of the full-stack remote
app pattern. It is not yet a complete third-party app platform: it lacks an
explicit app/installation registry, fine-grained requested permissions,
sender-constrained server credentials, version policy, and fully specified
long-lived-session revocation.

## Keep three flows separate

Most of the apparent contradictions disappear when these three flows are not
collapsed into one:

| Flow                        | What travels                                          | Who needs authority                                                       |
| --------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------- |
| Document and asset delivery | HTTP `Request` → HTML, JS, CSS, images                | The renderer may need no ITX authority at all for immutable assets        |
| Interactive browser API     | Long-lived Cap'n Web/WebSocket or ordinary HTTP calls | The signed-in user, attenuated to the selected project and app            |
| Server/background API       | SSR reads, server functions, webhooks, jobs           | Either the current user or the app installation, explicitly distinguished |

An SSR request and the hydrated browser are also two different clients. A live
capability used while rendering HTML cannot simply be inherited by the browser
which later executes that HTML. The browser must open its own channel, use a
same-origin BFF, or receive an explicit browser credential.

## What Tasks does today

The relevant implementation is:

- the project router in
  [`configs/default/worker.ts`](../configs/default/worker.ts);
- the full-stack Tasks entrypoint in
  [`apps/tasks/src/worker.ts`](../apps/tasks/src/worker.ts);
- the Tasks Cap'n Web root in
  [`apps/tasks/src/rpc-api.ts`](../apps/tasks/src/rpc-api.ts);
- the browser's shared Tasks connection in
  [`apps/tasks/src/lib/use-checkout.ts`](../apps/tasks/src/lib/use-checkout.ts);
- project-app session minting in
  [`apps/auth/src/server/project-app-session.ts`](../apps/auth/src/server/project-app-session.ts);
- project-host authentication in
  [`src/auth/project-auth.ts`](../apps/os/src/auth/project-auth.ts).

Tasks is deployed once at `tasks.iterate.workers.dev`. Each project does not
deploy a copy. A project config worker selects it for
`tasks--<project>.iterate.app` and reverse-proxies pages, assets, API calls, and
WebSocket upgrades.

```text
browser
  │
  │ https://tasks--<project>.iterate.app/...
  ▼
OS ingress
  │ resolve host → project id + app slug
  │ overwrite trusted routing headers
  ▼
project config worker
  │ project-member auth gate
  │ transparent fetch to tasks.iterate.workers.dev
  ▼
one deployed Tasks app
  ├─ TanStack Start SSR and static assets
  ├─ /api: app-specific Cap'n Web API
  ├─ /yjs/*: collaborative WebSockets
  └─ Tasks Durable Objects
          │
          │ authenticate to https://os.iterate.com/api
          ▼
         ITX
```

### Which values are trusted

OS ingress resolves the hostname and always overwrites
`x-itx-project-id`, `x-iterate-app`, and the other internal routing headers.
The browser cannot choose a different project by spoofing one of those headers
at project ingress.

The external Tasks origin is public, though. Someone can call it directly and
forge `x-itx-project-id`. Tasks therefore must not treat that header as
authority. It is a routing hint. The actual authority is the signed
`iterate-project-auth` token, whose project claim is verified by presenting it
to OS.

This is the general rule for remote apps:

> An unsigned proxy header is trustworthy only when bypassing the proxy is
> impossible. A publicly reachable third-party origin needs a signed assertion,
> a sender-authenticated channel, or verification-by-use against OS.

### The browser login flow

The project config worker calls the project capability's partial auth fetch:

```ts
const denied = await this.fetchProjectAuth(request, { policy: "project-member" });
if (denied) return denied;
```

When no valid project-app cookie exists, the platform sends the browser through
the existing Iterate login and project-membership flow. Auth mints a 15-minute
JWT containing at least:

- the exact app origin as `audience`;
- `projectId`;
- `userId`;
- issue and expiry times;
- optional display identity.

The app-host callback redeems that value into a host-only
`iterate-project-auth` cookie with `HttpOnly`, `SameSite=Strict`, `Secure`, and
`Path=/`. The upstream application never receives the primary
`auth.iterate.com` session.

On subsequent requests, OS validates the app token locally with HS256. There is
no auth-worker call on the hot path. Membership was checked when the token was
minted; the 15-minute lifetime bounds staleness for new HTTP requests.

Therefore a page reload does **not** perform a separate “get me an API token”
round trip. A first visit or an expired cookie performs the login/callback
ceremony. An ordinary reload carries the existing cookie on the document
request.

### Why browser code calls the app's `/api`

The Tasks browser opens a same-origin WebSocket to `/api`. That request follows
the same reverse-proxy route to the Tasks backend, and the browser automatically
sends the app-host cookie. Tasks exposes an unauthenticated Cap'n Web root whose
only useful door is `authenticate()`. The server reads the cookie from the
WebSocket handshake and returns a Tasks-specific project capability.

```ts
const session = newWebSocketRpcSession<TasksApi>(new URL("/api", window.location.href).toString());
const project = session.authenticate();
```

`authenticate()` is deliberately not awaited before dependent calls. Cap'n Web
promise pipelining can authenticate and perform the first operation in one
logical round trip. This is the pattern documented in the
[Cap'n Web authentication example](https://github.com/cloudflare/capnweb/blob/f6cd6863d5554a2964c1396bab2274359a45e037/README.md#more-complicated-example)
and its
[`RpcPromise` description](https://github.com/cloudflare/capnweb/blob/f6cd6863d5554a2964c1396bab2274359a45e037/README.md#rpcpromiset).

The Tasks backend then dials `https://os.iterate.com/api` and presents the
forwarded token as:

```ts
{
  type: ("project-app-session", token);
}
```

This is a BFF/application-backend topology:

```text
browser ──Cap'n Web──> Tasks API ──Cap'n Web──> OS ITX
           app API                    project ITX
```

The browser is not secretly calling OS through the same socket. It is calling
the Tasks API. Tasks owns its own API vocabulary and Durable Objects, and calls
ITX as one dependency.

### Tasks is already a full-stack TanStack Start app

[`apps/tasks/src/worker.ts`](../apps/tasks/src/worker.ts) exports a
`createServerEntry({ fetch(request) { ... } })` handler and delegates ordinary
requests to TanStack Start's server handler. The reverse proxy does not reduce
it to an SPA. It can serve:

- server-rendered documents;
- TanStack server routes/functions;
- static assets;
- streaming responses;
- an app-specific Cap'n Web API;
- Yjs WebSocket endpoints;
- Durable Object-backed state.

An SSR loader can make authenticated ITX calls on the server if the request
gives the server an app-session credential or the runtime gives it a scoped ITX
binding. It should serialize rendered data, not the credential, into the HTML.
After hydration, browser operations use a separate same-origin API connection.

### Current security limitations worth making explicit

The present system is appropriate for a deliberately trusted app, but two
details matter before generalizing it to arbitrary publishers:

1. At the project-host auth gate, `audience` is checked against the exact app
   origin. At the public OS `/api` `project-app-session` lane,
   [`UnauthenticatedOsRpcTarget`](../apps/os/src/rpc-targets.ts) verifies
   signature and
   expiry, then keeps `projectId` and `userId`; it does not prove that the caller
   is the app named by the token's audience. At that door the token therefore
   behaves as a short-lived bearer delegation. A party which steals it can use
   it directly until it expires.
2. Expiry bounds the creation of new authenticated sessions, not automatically
   the lifetime of an already-returned Cap'n Web capability or an already-open
   Yjs connection. A marketplace-quality design needs an explicit maximum
   connection lifetime, revalidation, or revocation signal.

Neither issue means the proxy design is wrong. They identify the difference
between “a trusted Tasks app” and “a general third-party installation model.”

## Precedent

### Identity-aware proxies

The proxy-authenticates-and-stamps-identity pattern is mainstream:

- [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)
  sends a signed `Cf-Access-Jwt-Assertion` to an origin and uses an
  application-specific audience.
- [Google Identity-Aware Proxy](https://cloud.google.com/iap/docs/signed-headers-howto)
  sends `x-goog-iap-jwt-assertion`; Google explicitly warns that unsigned
  identity headers are forgeable if the backend can be reached around IAP.
- [AWS Application Load Balancer OIDC authentication](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/listener-authenticate-users.html)
  keeps an authentication session at the load balancer and forwards signed
  user claims to its target.

Those systems do not require each protected backend to implement login
directly. The backend trusts a platform-controlled boundary and validates a
signed, audience-bound assertion.

The unusual part here is not the proxy. It is allowing a project owner to point
that proxy at infrastructure operated by an independently updating third party.
That is still a coherent model, but it is closer to installing a privileged app
than to changing a harmless theme.

### Backend-for-frontend

The IETF's current
[OAuth guidance for browser-based applications](https://datatracker.ietf.org/doc/draft-ietf-oauth-browser-based-apps/26/)
describes a BFF as the most secure of its three principal browser
architectures: the BFF holds tokens in a cookie-backed server session and
forwards API interactions, avoiding direct token exposure to browser code.

The same document calls the design which hands an access token to browser
JavaScript a “token-mediating backend.” It is viable, but token theft by
malicious browser code remains possible. This is the exact trade-off between:

- browser → same-origin project API/BFF; and
- browser → `os.iterate.com` with an explicit bearer token.

### One app, many installations

The closest precedent for avoiding one OAuth client per project is the
[GitHub App installation model](https://docs.github.com/en/apps/using-github-apps/installing-a-github-app-from-a-third-party):

- a publisher registers one app;
- an owner installs it into an account or selected repositories;
- the installation records approved permissions;
- the app can act as a user or independently as the installation;
- [installation access tokens](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation)
  are short-lived and cannot exceed the installation's resources or
  permissions.

Iterate can use the same conceptual split:

- one **app identity** per published dashboard/backend;
- one **installation** per project;
- a short-lived **user-on-installation session** for interactive work;
- an independently revocable **installation credential** for background work.

`auth.iterate.com` remains the one identity provider. A project owner does not
create or configure an OAuth client. Installing an app is an Iterate operation,
not an OIDC integration exercise.

### Object capabilities

[Cloudflare Workers bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/)
are “permission and API in one piece”: code receives a callable binding without
seeing its underlying secret. Workers Service Bindings can call another Worker
without a public URL and, according to Cloudflare's
[Service Binding documentation](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/),
normally run without an Internet network hop.

[Cap'n Web](https://github.com/cloudflare/capnweb/tree/f6cd6863d5554a2964c1396bab2274359a45e037)
extends the same model across HTTP, WebSocket, and `MessagePort`. It supports:

- bidirectional calls and callbacks;
- objects and functions passed by reference;
- promise pipelining;
- capabilities passed onward to another connection.

When a stub is passed across independent connections today, calls are proxied
through the intermediary; Cap'n Web does not yet perform a direct three-party
handoff. That is relevant to a gateway which hands a remote renderer an ITX
stub: the gateway remains on the call path.

## The dashboard can be replaceable

There are two useful scopes, and they should not be confused.

### Project dashboard

An app selected by `os--<project>.iterate.app` can safely receive a capability
for exactly that project. The project owner is the correct person to install it.
This is the natural first extension point.

### Whole user-level OS shell

The canonical OS shell can list every project a user may access and includes
platform-level routes. One project owner cannot delegate the user's access to
other projects. A true whole-OS replacement therefore needs either:

- separate user consent for a session/catalog capability;
- installation into each project, with the alternate shell listing only its
  installations; or
- first-party/platform-admin trust.

The renderer can still be technically stateless, but the authority boundary is
broader than the per-project Tasks pattern.

## Supported hosting models

The platform does not need to choose only one model.

| Model                   | Document/assets                                            | Browser API                             | Server/background                          | Best use                                                        |
| ----------------------- | ---------------------------------------------------------- | --------------------------------------- | ------------------------------------------ | --------------------------------------------------------------- |
| Platform-loaded Worker  | Dynamic Worker `fetch(request)`                            | Same-origin ITX or app API              | Scoped `env.ITX` binding                   | First-party or source-loaded project apps                       |
| External full-stack app | Reverse proxy to remote origin                             | App's same-origin BFF/API               | User delegation or installation credential | Tasks-like apps with their own backend                          |
| Static/CDN SPA          | Tiny project-origin shell plus direct immutable CDN assets | Platform-owned same-origin ITX endpoint | None, unless separately installed          | Replaceable renderer with minimal server                        |
| Direct browser client   | Any origin                                                 | Explicit token to `os.iterate.com`      | Separate credential                        | Native clients or intentionally public OAuth-style integrations |

### Platform-loaded Worker

This is the cleanest capability design. The platform creates a dynamic
`WorkerEntrypoint`, supplies JSON installation configuration in `ctx.props`,
supplies a project-scoped `env.ITX` binding, and invokes its real fetch handler.

The repository already does this in
[`src/domains/workers/worker-runner.ts`](../apps/os/src/domains/workers/worker-runner.ts):

```ts
const entrypoint = worker.getEntrypoint(name, { props });
return entrypoint.fetch(request);
```

The ITX binding is host-minted; app code does not choose its project. The
distinction between RPC method calls and the real fetch lane, especially for
WebSocket upgrades, is documented in
[`dynamic-worker-dispatch.md`](../apps/os/docs/dynamic-worker-dispatch.md).

### External full-stack app

The project origin authenticates and proxies to an external origin. The remote
server may render HTML, own API endpoints and Durable Objects/databases, and use
ITX from server code.

For hydrated interactions it has two choices:

1. **App BFF:** browser calls the app's `/api`; app calls ITX. This is what Tasks
   does. It allows an app-specific backend and never exposes an ITX bearer to
   browser JavaScript.
2. **Platform ITX endpoint:** browser calls a platform-owned reserved endpoint
   on the project origin. This makes sense when the “full-stack” app wants SSR
   but browser components use the standard ITX client directly.

The proxy must correctly handle streaming bodies, `Set-Cookie`, redirects,
WebSocket upgrades, cancellation, and cache headers. It must never cache
personalized HTML under a key shared by different users.

### Static/CDN SPA

The project worker need not proxy every hashed asset. It can serve a tiny HTML
shell from the project origin whose script and stylesheet URLs point directly
at a CDN:

```html
<script type="module" src="https://cdn.vendor.example/dashboard/v123/assets/app-8ca1.js"></script>
```

The project origin still supplies the trusted login and same-origin API
boundary. Immutable, content-addressed assets then avoid the proxy hop and can
be cached globally. Personalized HTML and API responses remain uncacheable or
properly partitioned.

A platform API namespace is not “mythical” if it is an explicit protocol
contract. Prefer a narrow namespace such as `/.iterate/itx` over taking an
application's generic `/api`, because a full-stack app reasonably owns its own
API routes. A separate platform API hostname is another option, but brings
cross-origin policy back into the design.

### Direct browser calls to `os.iterate.com`

This is more literal, but not automatically better.

The existing OS browser credential is deliberately exact-origin. A page on
`alternate-os.vendor.example` cannot use the `os.iterate.com` HttpOnly cookie as
if it were same-origin, and browser WebSockets cannot set an arbitrary
`Authorization` header. Cap'n Web therefore recommends in-band authentication
for browser WebSockets in its
[security considerations](https://github.com/cloudflare/capnweb/blob/f6cd6863d5554a2964c1396bab2274359a45e037/README.md#security-considerations).

The alternate app can call OS directly if JavaScript receives a short-lived
token and passes it to `authenticate()` in-band. That creates several
consequences:

- the token is visible to any script running in that app;
- XSS can exfiltrate and replay it away from the browser;
- CORS and WebSocket Origin policy become public API contracts;
- reload loses a memory-only token, while persistent browser storage increases
  theft exposure;
- a token endpoint adds a request unless the launch document embeds a token or
  one-time ticket.

Sender-constrained tokens such as
[DPoP (RFC 9449)](https://datatracker.ietf.org/doc/html/rfc9449) can reduce
off-device replay, but add key and proof management and do not make malicious
code inside the app harmless.

Direct explicit tokens are sensible for CLI, native, and independently
authorized OAuth-style clients. They are not the preferred default for a
dashboard which already has a same-origin platform gateway.

## There is no second Fetch argument for app context

This correction is important.

The web Fetch API is:

```ts
fetch(resource, requestInit?)
```

Its optional second argument is
[`RequestInit`](https://developers.cloudflare.com/workers/runtime-apis/fetch/),
not arbitrary application context.

A module Worker handler may be written as:

```ts
export default {
  fetch(request, env, ctx) {
    // ...
  },
};
```

but `env` and `ctx` are supplied by the Workers runtime. A caller does not pass
them as the second and third arguments of `binding.fetch()`. A
`WorkerEntrypoint`'s reserved fetch method is likewise called as
`entrypoint.fetch(request)`.

Context must be bound before the call or encoded into the request.

### Valid on-platform binding

Cloudflare's
[`ctx.exports` and `ctx.props` API](https://developers.cloudflare.com/workers/runtime-apis/context/#specifying-ctxprops-when-using-ctxexports)
has the configure-then-call shape:

```ts
import { WorkerEntrypoint } from "cloudflare:workers";

type Props = { projectId: string; configuration: unknown };

export class SomeApp extends WorkerEntrypoint<Env, Props> {
  async fetch(request: Request): Promise<Response> {
    const configuration = this.ctx.props.configuration;
    const itx = this.env.ITX;
    // ...
    return new Response("...");
  }
}

const app = ctx.exports.SomeApp({
  props: { projectId, configuration },
});
return app.fetch(request);
```

Cloudflare permits persistently serializable values, including Service
Bindings, in dynamically specified loopback props. Iterate's current
`StatelessDynamicWorkerRef.props` deliberately accepts JSON only; live ITX
authority is supplied separately through `env.ITX`. Expanding props to carry
live capabilities would be a platform API change, not something Fetch already
does.

### Valid RPC factory

The user's proposed shape is also coherent if `create` is an app-defined RPC
method which returns a Fetcher capability:

```ts
const app = bridge.create({
  configuration,
  itx: requestScopedItx,
});

return app.fetch(request);
```

Here `create(...)` is Cap'n Web/Workers RPC, not Fetch. It binds the context and
returns an object whose later `fetch(request)` remains fetch-shaped. Promise
pipelining can collapse `create()` and the dependent `fetch()` into one logical
round trip.

An RPC API could instead define `render(request, context)`, but that is
deliberately a custom RPC method. It should not be described or typed as the
Fetch API.

### Valid ordinary HTTPS proxy

An external HTTPS origin cannot receive a live Worker binding through ordinary
`fetch`. Its context must arrive in the `Request`, normally as:

- a host-only app session cookie;
- a signed identity assertion header;
- trusted routing metadata which is always stripped and restamped;
- or an opaque installation identifier paired with server authentication.

The remote app should never infer authority from a plain project-id header.

## The bidirectional Cap'n Web bridge

The proposed bridge is not crazy. It is a direct application of Cap'n Web's
object-capability model.

One possible server-side shape is:

```text
OS identity gateway                         remote app
       │                                        │
       ├──── establish Cap'n Web session ──────►│
       │                                        │
       ├─ create({ config, scopedItxStub }) ───►│
       │◄──────── configured Fetcher stub ──────┤
       │                                        │
       ├──────────── fetch(request) ───────────►│
       │                       scopedItx.foo() ─┤
       │◄───────────────────────────────────────┤
       │──────────── capability result ────────►│
       │◄─────────── Response / stream ─────────┤
```

The remote app calls the supplied ITX stub back over the same bidirectional
connection. Authentication and the first dependent call can be pipelined.
There is no reusable bearer secret for the app to leak.

Cap'n Web can pass `Request`, `Response`, streams, callbacks, and capability
stubs. The Iterate fork also supports
[WebSocket tunnelling](https://github.com/cloudflare/capnweb/blob/f6cd6863d5554a2964c1396bab2274359a45e037/README.md#tunneling-websockets).
The current internal dynamic-worker boundary is more constrained; see
[`dynamic-worker-dispatch.md`](../apps/os/docs/dynamic-worker-dispatch.md) for
where a
materialized WebSocket cannot cross ordinary workerd RPC.

### What the bridge improves

- Reuses one authenticated server-to-server transport for many calls.
- Avoids repeatedly opening TLS/WebSocket sessions from the app backend to OS.
- Gives the app an attenuated capability instead of a reusable token.
- Supports callbacks, push, and server-initiated operations naturally.
- Promise pipelining can collapse factory/auth/dependent calls.
- Makes the gateway an observable policy and accounting point for every ITX
  operation.

### What it does not improve

- The initial document request still has to reach the remote renderer.
- The browser cannot reuse the SSR server's connection.
- CDN asset delivery gains nothing from an RPC bridge.
- A malicious installed app can still exercise every operation its capability
  permits and exfiltrate returned data.
- A connection-bound capability does not by itself provide durable background
  identity after disconnection.

### Operational costs

- Connection ownership, reconnect, disposal, backpressure, rate limits, and
  maximum lifetime become platform protocol.
- Horizontal scaling needs affinity or a connection directory. A Fetcher stub
  owned by one gateway isolate is not magically available in another.
- Per-user capability sharing is dangerous: a pooled app connection must not
  let one request obtain another user's authority. Either multiplex explicit
  request-scoped actor capabilities safely or use separate sessions.
- A broken connection invalidates its stubs. Recovery must recreate and
  reauthorize them; there is no documented Cap'n Web session resume.
- When a stub crosses two independent connections, calls currently remain
  proxied through the intermediary. The gateway is a durability and latency
  dependency.
- Long-lived WebSockets consume operational attention even when their byte
  overhead is small: deploys, draining, half-open detection, revocation, and
  tracing all need explicit behavior.
- Cap'n Web pipelining lets clients enqueue dependent work aggressively, so
  validation, rate limits, and CPU budgets are required.

### Recommendation on the bridge

Treat it as a valuable optimization and capability-security experiment, not as
a prerequisite for replaceable dashboards.

Start with:

- direct CDN URLs for immutable assets;
- ordinary project-origin proxying for documents and full-stack app APIs;
- platform-local bindings for platform-loaded renderers;
- one shared browser Cap'n Web session for a pure renderer;
- HTTP batch or a normal authenticated Cap'n Web dial for remote SSR/backend
  work.

Measure cold connection time, extra subrequests, SSR latency, and steady-state
call volume. Introduce the bidirectional bridge when those measurements show
that repeated backend dials are material or when callback/capability semantics
are valuable independently of latency.

## Authentication model for a general app platform

### Do not forward the primary Iterate session

`auth.iterate.com` is the identity provider, analogous to a self-hosted Clerk.
It should authenticate the user once, but its primary cookie or broad access
token should not be handed to arbitrary upstream apps.

The gateway should mint a derived credential or capability with less authority.
There are two different products to mint.

### Interactive user session

For requests made as the current person:

- subject: user id;
- project id;
- app id and installation id;
- exact allowed origin or backend identity;
- requested ITX scopes/capability root;
- short expiry;
- unique id for audit/revocation where needed.

If it is an identity assertion consumed by the remote origin, its audience is
that origin/installation. If it is an OS API access token, its audience is the
OS resource and it should separately identify the authorized app
(`client_id`/`azp`/installation). One token should not ambiguously serve both
roles.

The strongest forms are:

- the gateway retains the credential and supplies an ITX capability;
- the gateway BFF forwards API calls;
- or the remote backend authenticates as the installation and exchanges the
  user assertion for a short-lived OS access token.

[OAuth Token Exchange (RFC 8693)](https://datatracker.ietf.org/doc/html/rfc8693)
is precedent for exchanging subject and actor credentials into an attenuated
delegation, although Iterate need not expose the full standard on day one.

### Background installation identity

Out-of-band work must not reuse a browser cookie or pretend a user is still
present. It needs a separately visible principal such as:

```text
app-installation:<app-id>@<project-id>
```

An installation record should include:

- publisher/app identity and verified origins or public keys;
- project;
- requested and approved permissions;
- who installed it and when;
- whether user-delegated and/or background access is allowed;
- version/update policy;
- suspension, revocation, and audit history.

The app authenticates its own server and receives a short-lived installation
token or capability. The token cannot exceed the installation's project and
permissions. Uninstalling or suspending the app prevents new credentials and,
where required, terminates existing sessions.

The existing `project-secret` credential in
[`src/auth.ts`](../apps/os/src/auth.ts) is already a machine lane: it grants
exactly one project, no admin, and no user identity. It is useful for trusted
external services today. A general marketplace should prefer an app-specific,
permissioned installation credential over sharing that broad, long-lived
project birth secret with every vendor.

This design avoids per-project OAuth clients. At most, a publisher registers
one app with Iterate. Project owners only approve installations.

## Security requirements

A production design should make these invariants explicit.

### Authority and isolation

- The hostname, project id, app id, installation id, and permission set are
  resolved by the platform, never accepted from untrusted request headers.
- A project installation cannot widen into the user's other projects.
- A renderer receives the smallest useful ITX root, not automatically every
  project capability.
- User and installation principals remain distinguishable in audit trails.
- Background operations never inherit an absent user's identity.

### Upstream trust

- Strip every platform-reserved header at public ingress, then stamp trusted
  values.
- Use signed assertions for origins which can be reached around the proxy, or
  make them binding-only/private.
- Validate issuer, signature, audience, expiry, app/installation, project, and
  scopes.
- Do not log cookies, assertions, access tokens, or capability bootstrap data.
- Require HTTPS and verify the configured origin. Protect origin changes like a
  permission change.

### Browser security

- Use host-only, `Secure`, `HttpOnly`, restrictive `SameSite` cookies.
- Check exact `Origin` for WebSocket authentication and state-changing
  same-origin operations.
- Keep authentication callback paths platform-owned and prevent open redirects.
- Use CSP appropriate to third-party assets; pinning can additionally use
  content hashes/SRI where the deployment model permits it.
- Remember that BFF architecture prevents token extraction, not malicious
  behavior by installed JavaScript. Permission attenuation is still necessary.

### Sessions and revocation

- Specify the maximum lifetime of connection-bound capabilities.
- Revalidate or terminate long-lived RPC and collaboration connections on
  expiry, uninstall, project-membership revocation, or app suspension according
  to a documented policy.
- Bound reconnect and retry behavior. Preserve an observable reason for
  terminal authentication failures.
- Rotate app and installation credentials without accepting an indefinite
  legacy credential.

### Caching

- Serve immutable content-addressed assets with long public caching.
- Do not publicly cache personalized HTML or authenticated API responses.
- Include authentication context in any deliberate private cache key.
- Preserve `Vary`, `Cache-Control`, `Set-Cookie`, and streaming semantics
  through proxies.
- Never let an upstream response poison platform-owned routes or headers.

### Supply-chain trust

A project which follows “latest” third-party code grants the publisher
continuing authority. Make that visible:

- show publisher, requested permissions, current version, and update policy;
- support pinned versions as well as opt-in auto-update;
- record updates and permission changes;
- require new approval when permissions widen;
- provide an immediate kill switch and uninstall;
- consider signed manifests or content digests.

## Performance analysis

### What costs a round trip

For the current Tasks pattern:

- the first unauthenticated visit performs the login/callback redirects;
- an authenticated reload does not fetch a new token;
- the document still traverses the config-worker proxy;
- the hydrated browser opens its app WebSocket;
- the Tasks backend opens an OS Cap'n Web connection when it first needs ITX;
- later operations reuse those live connections until reconnect.

Cap'n Web pipelining avoids a separate completed authentication round trip
before the first dependent operation. It does not eliminate the underlying
WebSocket handshake.

### Proxy overhead

For a platform-loaded Worker, Service Binding/fetch hops are designed to be
cheap and avoid the public Internet. For an externally hosted app, an extra
upstream hop is real. Its impact depends much more on placement, cold starts,
render time, and backend call waterfalls than on the few microseconds of proxy
JavaScript.

The highest-value optimizations are likely:

1. send immutable assets directly to a CDN;
2. co-locate or smart-place the renderer and its data path;
3. pipeline or batch SSR data reads;
4. share one browser RPC connection;
5. avoid opening a new backend RPC connection for every small server operation;
6. add the persistent bridge only if measurements justify its lifecycle cost.

Do not bypass the identity boundary merely to remove one visible URL hop. The
gateway is performing useful security work.

## Recommended product contract

The following is a reasonable target, independent of the exact wire format.

### Installation

```ts
type ProjectAppInstallation = {
  appId: string;
  projectId: string;
  permissions: string[];
  ui:
    | { kind: "platform-worker"; ref: unknown; configuration: unknown }
    | { kind: "remote"; origin: string; assetBase?: string }
    | { kind: "static"; document: string; assetBase: string };
  backgroundAccess: "none" | "installation";
  updates: { policy: "pinned" | "automatic"; version: string };
};
```

This is illustrative, not a proposed checked-in type.

### Platform-owned routes

Reserve a narrow, documented namespace such as:

```text
/.iterate/auth/*
/.iterate/itx
/.iterate/app/*
```

The exact names can change. The important part is that the contract is explicit
and does not steal the full-stack app's ordinary `/api`.

### Runtime behavior

- A platform Worker app is created with installation props and a scoped
  `env.ITX`, then called with `fetch(request)`.
- A remote full-stack app receives an authenticated request plus a signed app
  assertion, and may expose its own same-origin APIs.
- A static renderer gets direct CDN delivery and dials the platform-owned ITX
  endpoint.
- The browser never needs a general OS bearer in the default modes.
- Background work authenticates as the app installation.

## Suggested rollout

1. **Name the contract.** Document app identity, installation, user session,
   installation principal, reserved namespace, and capability scope.
2. **Harden the existing Tasks lane.** Make app identity/audience enforcement
   and maximum connection lifetime explicit; add installation-level revocation.
3. **Extract a renderer SDK.** Let a static SPA connect to project-scoped ITX
   through a stable same-origin endpoint.
4. **Separate assets from dynamic requests.** Prove a CDN-served alternate
   renderer without proxying hashed assets.
5. **Add one-app/many-installations.** Introduce requested permissions and a
   short-lived background credential.
6. **Prove SSR.** Build a small TanStack Start app whose server loader uses
   request-scoped ITX and whose browser uses either its BFF or the platform
   endpoint.
7. **Measure.** Trace document proxy time, connection setup, SSR ITX
   waterfalls, and steady-state browser calls.
8. **Prototype the Cap'n Web bridge only against a measured target.** Specify
   reconnect, affinity, disposal, revocation, rate limits, and tracing before
   treating it as the default transport.

## Final assessment

The appealing idea is sound:

> OS can be the durable identity/capability operating system, while its project
> dashboard is one replaceable application of that operating system.

The safe boundary is not “frontend versus backend.” It is:

- platform-controlled identity and authority;
- app-specific, project-scoped delegation;
- explicit installation trust;
- separate interactive-user and background-app principals;
- a stable API/capability contract.

Tasks demonstrates that a single independently deployed full-stack app can sit
behind a project config worker, use Iterate login without its own OAuth client,
render SSR pages, run its own backend and Durable Objects, and make
user-attributed ITX calls. A CDN-only SPA is a simpler subset. A bidirectional
Cap'n Web bridge is a plausible evolution, but it solves connection reuse and
capability handoff—not the browser/server lifetime split, installation trust,
or revocation model.

Most importantly, the correct invocation remains:

```ts
const app = SomeApp.create({ configuration, capability });
return app.fetch(request);
```

or, for an ordinary remote origin:

```ts
return fetch(new Request(origin, authenticatedRequestInit));
```

It is never an invented `fetch(request, appContext)`.
