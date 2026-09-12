# Implementation interface review

Claude Fable 5.1 (`claude-fable-5-1`), xhigh, read-only review, 2026-09-10.

This review began before the owner's routing correction. All recommendations to
put MCP at `/api` or Cap’n Web at `/api/rpc` are rejected: `/api` stays Cap’n Web
and MCP uses `mcp.iterate2.com`. A focused resource-audience review follows.
The statement that `apiRoute` matches exact paths is also incorrect: the provider
uses prefix matching. The edge must enforce the actual public route contract.

Accepted interface findings: keep issuer login separate from the console client;
move consent outside the console-grant layout; share the browser client; bind
OAuth grants to current membership; preserve synchronous Cap’n Web dispatch; and
prove CIMD self-fetching on the real deployment. A config worker's local auth check
should use the verified request identity supplied by ingress, avoiding an extra
RPC solely to inspect an already-validated request.

## Reviewer response (before those corrections)

**Verdict**

The shape is right in outline. Three corrections are required before code: pin the provider to the configured platform origin, move the config-worker check out of the DO and into the SDK, and take the consent route out of the console's authenticated layout. Delete project tokens and the project-session door outright.

**Smallest module set**

- `src/oauth.ts` (split out of control-plane.ts): one `providerOptions(env)` used by both `new OAuthProvider(options)` and `getOAuthApi(options, env)`. Exports `resolveExternalToken`, `tokenExchangeCallback`, and `admissionOf(props)` returning `{ kind: "admin" } | { kind: "user-grant"; userId; grantId; projects?: string[]; expiresAt }`. Access-token props are that discriminated object, never a bare `actor` string.
- `src/browser-client.ts`: `browserClient(request, host): Promise<Response | null>` serving `/.auth/client.json` (the CIMD document, `client_id` equal to its own URL, one redirect URI `${origin}/.auth/callback`, `token_endpoint_auth_method: "none"`), `/.auth/login`, `/.auth/callback`, `POST /.auth/logout`, and `/.auth/rpc`. Plus `identityOf(request, host): Promise<Principal | null>`. Mounted twice: in `consoleHandler` before `consoleDoor`, and in the project-host branch of `worker.ts` after the directory admission at line 186 and before the DO dispatch at line 196.
- `BrowserSession` Durable Object (new binding): `begin(tx)`, `complete(code, state)`, `bearer()` with one in-flight refresh promise, `end()`. Token exchange and refresh call `controlPlane.fetch` in-process with a synthetic request to `P/oauth/token`. No network self-fetch.
- `src/sdk/index.ts`: `requireUser(request): Response | null` and `principalOf(request): Principal | null`, both synchronous.
- `control-plane.sql`: the `oauth_activity` table as you specified.

Cookie: `__Host-itx-session` holding a random BrowserSession id. The edge strips it from what the app sees exactly as `withoutProjectSessionCookie` does today.

**Answers to the open questions**

Issuer login should stay a signed cookie, not the DO. It is read by `/login` and `/authorize` only. Central SSO falls out for free: a second host's `/.auth/login` lands on `P/authorize` with the issuer cookie present and shows consent. Smallest honest logout: `POST /.auth/logout` on a host writes the activity marker, calls `revokeGrant`, ends the DO, clears the host cookie. The issuer cookie is not an inventory row, so say so in the UI and shorten it to a browser-session cookie with no `Max-Age`. "Sign out everywhere" is revoke-all on the Sessions page plus `POST /logout`.

Config-worker check: native RPC can carry a `Request` as an argument, but that does not help. Three facts in existing source decide it. A loaded worker's `env.ITX.get()` has no principal (iterate-context.ts:531-538). Any expression ending in `fetch` with a `Request` is hijacked by the terminal-fetch fork onto the DO fetch channel, which can only return a `Response`, and that fork deletes the principal header (iterate-context.ts:187-198). And the DO would otherwise have to trust a header on a Request that userspace constructed. So `itx.auth.fetch(request)` cannot return `null` and cannot know who is asking. The edge already did the work: it resolves the cookie for this host and project, intersects grant ceiling with current membership, and stamps `x-itx-principal`, which the fetch lane leaves on the Request the app receives (iterate-context-durable-object.ts:830-838). The idiom becomes:

```ts
const denied = requireUser(request);
if (denied) return denied;
return fetch(new Request(upstreamUrl, request));
```

Zero hops, streaming and 101 untouched. The redirect goes to `/.auth/login?next=` on the same host, or 401 when `sec-fetch-mode` is not `navigate`.

**Genuine gotchas in the tracked source**

- Provider built per request from `new URL(request.url).origin` (control-plane.ts:869-889). Issuer and audience follow whatever hostname arrived. Add `APP_CONFIG_PLATFORM_ORIGIN`, pin `resourceMetadata.resource` to `P/api`, and refuse the control plane on any other host.
- `apiRoute` is an exact pathname match (provider 1826-1829). Use `apiRoute: ["/api", "/api/rpc"]`. Then probe `audienceMatches` (provider 3904-3925, 4653) with a token bound to `P/api` presented at `P/api/rpc`; if it compares paths, the resource must be the origin-level `P/api` and both routes must sit under it, which they do, but verify before building on it.
- CIMD has never been exercised here. Both lanes use DCR (control-plane.test.ts:412-448, specs/auth.spec.ts:288-305). The document must be https with a non-root path (provider 4272-4277), so no local lane can run the console's own login. The provider fetches the document with global `fetch`, and for `os.iterate2.com` or `*.iterate2.app` that is the worker fetching its own route. Probe on day one against the real deployment. There is no hook to serve the document in-process.
- Consent recursion: `_auth/authorize.tsx` sits under the `_auth` layout, which gates on `sessionOf` (routes/\_auth.tsx:6-12). Once `_auth` gates on a BrowserSession grant, consent needs a grant that needs consent. Move `/authorize` to a top-level route gated by the issuer cookie only. `approveConsent` and the `/authorize` machine door already use the issuer cookie and stay (control-plane.ts:734-757, 817-826).
- `completeAuthorization` defaults `revokeExistingGrants` to true and scopes it by user, client and redirect URI (provider 932-947, 1047-1053). The console's client_id and redirect URI are identical for every browser, so a second browser login would revoke the first. Pass `revokeExistingGrants: false`.
- `from-server-cookie` makes the issuer cookie API authority (session.ts:112-119), and `/api` serves an unauthenticated root (worker.ts:224-230). Both go. The provider validates the bearer, and the capnweb root becomes `Session` built from `admissionOf(ctx.props)`.
- `reachesProject` for a `{ projectIds }` reach never checks membership (control-plane.ts:252-258). A grant bound to a project the user has since left still reaches it. User-grant admissions must intersect with `listProjects(userId)` on every request; admin and project-secret reaches are unchanged.
- Egress deletes `x-itx-principal` (iterate-context-durable-object.ts:889-891). A config worker proxying to a real upstream cannot forward the platform header verbatim. It copies the principal into its own header and adds a shared secret through the existing `getSecret("/secrets/NAME")` placeholder, which egress substitutes and sends with `redirect: "manual"`. The upstream notes app trusts the principal header only after the secret matches. This is the whole "independent app" identity story and needs no new machinery.
- Live lease: `newWorkersRpcResponse` hides the socket pair (capnweb d.ts:559). Own it with `WebSocketPair` plus `new RpcSession(new WebSocketTransport(server), root, { onCall })` (d.ts:505-506, 319-325, 306). `onCall` must invoke synchronously (d.ts:302-306), so check a cached deadline there and renew it from a primary D1 read off the hot path. On expiry call `session.abort()`, close the server socket, and run `SessionTeardown.disposeAll`, which already recalls every lend.
- Per-request cost on project hosts becomes edge to BrowserSession DO to KV plus a primary D1 read. The DO may cache `unwrapToken` results under 60 seconds; the deny marker read stays fresh. Accept this.
- `tokenExchangeCallback` may return `refreshTokenTTL` only on the code exchange (provider 2829-2833). PAT grants get no `expiresAt` in `GrantSummary` (1296-1299), so expiry lives in grant metadata.

**What can be deleted**

- worker.ts:376-451: the project-session cookie, its door, and its set-cookie helpers. `projectHostIdentityOf` keeps admin secret, project secret, and the new cookie only.
- principal.ts:40-142: project tokens. The session-cookie half stays as issuer login.
- session.ts: `UnauthenticatedSession.authenticate`, the `from-server-cookie` and `project-token` credentials, `ProjectDoorsInput` for user grants (pass null so `mintToken` and `rotateApiKey` are FORBIDDEN as iterate-context.ts:210-240 already does).
- iterate-context.ts:202-225: `mintToken`. PATs replace it.
- control-plane.ts:636-656: the token-minting `open` links become plain host URLs. Line 877: `clientRegistrationEndpoint`. `/mcp` becomes `/api`.
- The DCR-based flows in control-plane.test.ts and auth.spec.ts, and the `/.itx/session` rows.

**First commit slice**

Pin the provider to configured P, route MCP at `/api` and capnweb at `/api/rpc` under one provider, drop DCR, and make the capnweb root a `Session` from `admissionOf(ctx.props)`. Delete `from-server-cookie` and `UnauthenticatedSession`. No browser client yet.

Acceptance, in the workers lane, one test file replacing the `/mcp` block of control-plane.test.ts:

1. The authorization-server document has no `registration_endpoint`; `POST /oauth/register` is 404.
2. Admin bearer: a capnweb HTTP batch `POST /api/rpc` answers `whoami()` with `{ actor: "admin" }` and `projects.create` works. A wrong secret is 401 with `WWW-Authenticate`. The issuer cookie alone is 401.
3. User grant: register a public client through `getOAuthApi(...).createClient` as the test fixture (the one thing CIMD cannot do on an http lane, stated in the test header), then run the real code plus PKCE exchange through `SELF.fetch`. The bearer on `/api` answers MCP `whoami` with the discriminated props. The same bearer on `/api/rpc` lists exactly the chosen projects, `projects.get(unchosen)` is FORBIDDEN, `mintToken()` and `rotateApiKey()` are FORBIDDEN, and deleting the user's `org_members` row makes a granted project FORBIDDEN on the next call.

Deployed smoke for the same commit: `/version` at `os.iterate2.com`, admin bearer on `/api/rpc`, and one real CIMD fetch of `https://os.iterate2.com/.auth/client.json` from the worker itself, because that self-fetch is the single largest unknown in the whole plan.

## Corrected resource-audience review

The focused Fable 5.1 xhigh review confirmed multiple audiences work with the
released provider when its global resource pin is omitted. The implementation
validates a nonempty finite resource list at consent and rejects old unstamped
grants. The browser adapter will turn its cookie into a bearer at the same gate;
the reviewer’s suggestion to bypass that gate for cookies is not adopted.

Done reading. Writing the recommendation now.

**Conclusion: drop the global pin, keep one provider/KV/issuer, enforce the resource allow-list yourself at consent, and let the provider's array-aware admission do the rest.** The premise that an array audience is rejected at the API only holds while `resourceMetadata.resource` is set. With no pin, a single bearer carrying `[P/api, M]` is admitted at both hosts by the provider itself.

**What the source establishes**

- **Pin semantics are all-or-nothing.** `isExactResource` (`/tmp/iterate-oauth-provider-v0.10.3.ts:4711`) accepts a string or a length-1 array only. It gates parseAuthRequest (5186-5196), completeAuthorization (5283-5288), the token endpoint (4151-4167), API admission (3881-3890) and external tokens (3961-3970). Any pin forbids multi-resource tokens everywhere.
- **Unpinned AS accepts arrays, no emptiness check.** parseAuthRequest collects repeated `resource` params (5149-5151) and only validates URI shape (5177-5185). completeAuthorization stores whatever it got, including `undefined` (5276-5288, 5442). Nonempty is your job.
- **Token endpoint downscoping is provider-enforced.** `resolveTokenResource` (4132-4183): with no pin, every requested resource must string-equal a granted one (4170-4180), and omission inherits the full granted array (4182). Both code exchange and refresh use it (2527, 2752).
- **API admission is per-request-URL and array-aware.** With no pin, 3907-3927 builds the resource server from the actual `request.url` and passes if any audience matches. `audienceMatches` (4653-4682) requires exact origin, then path-boundary prefix; an origin-only audience matches every path (4671). So `[https://os.iterate2.com/api, https://mcp.iterate2.com]` admits at `os/api/...` and `mcp/anything`, and nowhere else. An unbound token (no audience) skips the check entirely (3907).
- **tokenExchangeCallback cannot see audience.** Its options (205-244, 2555-2563) carry no resource. Your only hook with the resource in hand is the caller of completeAuthorization. That is where the check belongs.
- **PRM is auto-served per path.** Unpinned, `/.well-known/oauth-protected-resource[/suffix]` derives `origin + suffix` (1876-1882, 2297). On the mcp host this yields `https://mcp.iterate2.com`, no trailing slash. `resourceMatches` is string equality (4724), so your allow-list must use that exact spelling, not `M/`.
- **Issuer follows tokenEndpoint.** `getAuthorizationServerIssuer` (2163-2166) and PRM `authorization_servers` (2291-2298) derive from the token endpoint origin. With the path form `"/oauth/token"` used today (`control-plane.ts:421`), the mcp host would advertise itself as AS. Use full URLs; `matchEndpoint` compares hostname+path (1826-1834).

**Recommended shape**

- One `OAuthProvider` with `apiHandlers: { "https://os.iterate2.com/api": capnwebBearerHandler, "https://mcp.iterate2.com/": mcpHandler }` (full-URL routes match hostname + path prefix, 2098-2110), full-URL `authorizeEndpoint`/`tokenEndpoint`/`clientRegistrationEndpoint` on os, `resourceMetadata: { authorization_servers: ["https://os.iterate2.com"], scopes_supported: [...] }` and **no** `resource`. Take the AS origin from app config, not the request, so the local lane keeps working.
- Constants `ALLOWED = ["https://os.iterate2.com/api", "https://mcp.iterate2.com"]`, the same strings the PRM emits.
- In `approveConsent` (`control-plane.ts:279`), before completeAuthorization: normalize `oauthRequest.resource` to an array, require length ≥ 1, dedupe, require every element `∈ ALLOWED`; otherwise throw `AuthorizationError('invalid_target')` with the redirect fields `consentOf` already forwards (255-263). Do the same in `consentOf` so the client gets the redirect early.
- Stamp props: `{ ...principal, grantResources: resources, grantVersion: 2 }`. Props are encrypted by the provider and reach handlers as `ctx.props` (3930-3936); a caller cannot forge them. Both API handlers reject props lacking `grantVersion === 2`. This is the audited proof that the grant passed your nonempty check; the audience itself is enforced by the provider, so old `<origin>/mcp` or unbound grants fail either at admission (origin mismatch) or at the stamp check.
- Personal tokens: no "smallest protocol" compromise needed. Via `exchangeToken` the `aud` subset is enforced by the same `resolveTokenResource` (3019-3032); via `resolveExternalToken` return `audience` as the chosen subset, default both (3973-3993 handles arrays).

**Answer to the core question**

A bearer valid for both surfaces exists iff the authorization request listed both resources. MCP SDK clients send exactly the PRM value, so they get `[M]`; the browser sends `[P/api]`; your own console flow may request both. The provider stores the array and issues it on omission. You never fork or re-verify anything.

**Caveats**

- The provider's api admission demands `Authorization: Bearer` (3841-3851). Cookie and project-token traffic on /api must still bypass the provider as `worker.ts:225` does today; route only bearer requests into it.
- Path routes use bare `startsWith` (2105), so `/api` would also claim `/apiary`. Full-URL routes have the same behaviour; keep /api free of sibling paths.
- Internal `/mcp` on os is not covered by M (origin mismatch, 4659). Either add it as a third allowed resource or drop it.
- `resolveExternalToken` currently returns `${url.origin}/mcp` (`control-plane.ts:62`), which is tautological; return the configured constant for the handler instead.
