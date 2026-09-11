# Issuer-session implementation review — Claude Fable 5.1 xhigh

2026-09-10; requested model `claude-fable-5-1`, effort `xhigh`, tools disabled; completed successfully.

Disposition: keep the grant, admission, DO and shared app shape. Preserve raw OAuth query bytes in the client-only consent route; block framing; pin the provider’s existing S256 PKCE requirement with a regression; refuse empty delegated reach; add Cancel with the validated client redirect. Collapse provider-helper injection and duplicate loopback classification; remove redundant app scope defaults. Preserve the copied-client regression, since trusted grant purpose already enforces the boundary.

Source correction: v0.10.3 `parseAuthRequest` already calls `validateAuthorizationPkce`, which refuses public clients without PKCE. With `allowPlainPKCE: false`, S256 is already required. The proposed extra application check was removed after a real regression demonstrated the provider’s rejection.

Verified pinned-provider source: refresh responses include `scope`; a BrowserSession refresh regression now exercises that real response. Empty scopes normalize to `iterate`. Identity routes run only after the project-host and dedicated-MCP dispatch. Self-fetch works on the deployed `os.iterate2.com` route under `global_fetch_strictly_public`, as proved by the real deployed first-consent browser test. No workers.dev issuer is configured.

---

The shape holds. I found two real defects on the consent path and a few one-line hardenings. Nothing in the grant model, the admission gate, or the session DO needs to change.

## Blockers and real corrections

1. **The consent route reads the OAuth query through TanStack, which rewrites it.** TanStack rebuilds `searchStr` and `href` from its parsed search object, so every value round-trips through decodeURIComponent and encodeURIComponent, and repeated keys collapse into a JSON array string. The rewritten string is also what `next` carries through `/.auth/login`, `/login`, and Google, so the post-login landing URL is equally broken.
   - Symptoms: a `+` encoded space in scope arrives as a literal plus, so `scope=iterate+account` fails as one unknown scope. Two `resource` parameters arrive as one JSON array and fail invalid_target. Unit tests miss this because `approve` receives the raw `flow.url.search`.
   - Fix in `authorize.tsx` only. The route is client-only, so read `next` and `query` from `window.location` in beforeLoad, the loader, and the Switch-account link.

2. **The consent page can be framed.** The console handler sets only cache-control on HTML, and `/authorize` renders every project pre-checked behind a one-click Approve. Add `frame-ancestors 'none'` and `X-Frame-Options: DENY` where HTML is post-processed, and on the raw "Update permissions" page.

3. **PKCE is not required.** `allowPlainPKCE: false` only forbids plain; a public client that omits the challenge gets a code protected by redirect URI alone. Refuse in `parseAuthorization` when `codeChallenge` is absent. The provider still owns the crypto.

4. **Approve can mint a grant that reaches nothing.** Everything unchecked, or a project-bound client for a project the user cannot reach, yields an app grant with an empty project list. Refuse in `approve` when nothing was granted and the wildcard was not chosen. The bound-client empty state also says "create below" while hiding the creation section; show a no-access message instead.

5. **No Deny.** The page offers Approve and Switch account only, so a client the user declines never receives access_denied and hangs. `authorizationFailure` already builds error redirects; have `describe` return a deny location and render a Cancel link.

## Verify before deployed proof

- **Refresh response shape.** `TokenResponse` requires `scope`. If the provider omits it on refresh, every hourly refresh throws and the console reads as an outage. Make it optional with fallback to stored scopes, or add a test that drives a refresh.
- **Empty scope.** If a third-party client sends no scope, confirm the request ends as iterate rather than a grant the gate always refuses.
- **Mount order.** `identityDoor` must run before `appAuth` and only on the issuer origin. On a project host the flow cookie lands on the wrong host and the callback always reports expired.
- **Self fetch.** Login makes two round trips to the issuer's own origin: the CIMD lookup inside parseAuthRequest and the DO token exchange. This works on a Custom Domain and fails on workers.dev.
- **Hourly socket close.** The live lease ends at access-token expiry. A consent page left open past that holds a dead stub until the next invalidate. Acceptable, but the browser E2E should expect it.

## Flows I checked and consider correct

Empty user through org, project, and project-only MCP token. Google state, nonce, PKCE, signature, verified email, and stable sub. Copied console CIMD id yields app kind only, and its code can only land on the issuer's own callback. Revoked issuer session refused at approve and mint by the fresh D1 read. GET login never revokes; only the POST form replaces a grant. Login and loginPage chains terminate; revocation always lands on the explicit `/login` page. Callback failures clear the flow cookie and pending DOs expire by alarm. Grant end cannot address another user's grant.

## Simplification disposition

**Keep** BrowserSession as the single client, the issuer tail through the public exchange, the Consent and Grants split, the rpc lease, and the three empty-POST probes.

**Collapse**

- `parseAuthorization` should call `oauthHelpers(env)` itself. That deletes the env spread in the issuer tail, Consent, and mint, and removes the dependence on provider injection.
- One `isLocalOrigin`, protocol-aware, used by identity, control-plane, and `BrowserSession.begin`.
- Drop `defaultScopes` from the app auth config. The SPA always sends scope; a bare login can default to iterate.

**Tighten, optional.** Refuse the issuer's own CIMD id in `Consent.#request`. The console never consents to itself, so the only use of that id on the public path is a look-alike prompt. Not exploitable today; the second bootstrap test would flip to expect refusal.

**Do not add** orphan compensation, admin fields, or incremental scope upgrade.
