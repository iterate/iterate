# OAuth external-app review

Reviewer: Claude Fable 5.1, effort xhigh. Exact model verified from CLI model usage. Read-only review; no permission denials.

**Recommendation up front:** one SDK package with a bindings-free `AppSession` Durable Object and one `appAuth` adapter, all issuer traffic over public HTTPS including from the platform, in-process dispatch only for the `/api` proxy, and logout as a new `publicSession.logout()` RPC. Details and rejected options per decision follow.

**1. Where browser tokens live**

- A. Per-login DO exported by the SDK, bound in each app worker. Platform binds it once for both owned origins, Notes binds its own copy.
- B. One DO on the platform reached by service binding. Notes is a separate worker and cannot bind it, and "give me the bearer for cookie X" needs a proof of cookie ownership. That reinvents a session protocol.
- C. Encrypted-cookie tokens, no DO. Two tabs refreshing at once rotate the refresh token twice and one tab loses its session. Fails the requirement.

Pick A. Keep the current shape: `begin`, `complete`, `bearer`, `end`, `alarm`, every token operation under `blockConcurrencyWhile`.

**2. How the DO reaches the issuer**

- A. Public HTTPS for everything, platform included. Token exchange is a plain fetch to the token endpoint. Logout is a Cap'n Web batch session built on a Request with a Bearer header and an abort signal. The platform needs the `global_fetch_strictly_public` flag or self-fetch fails with error 1042.
- B. Base class with protected hooks for exchange, revoke and registration, with a platform subclass dispatching in-process as today. Two lifecycles, and the code path Notes depends on is never exercised by platform login.
- C. Self service binding for the platform's token exchange. Avoids the flag, but capnweb 0.12.2 uses global fetch only, so logout would still self-fetch. Split transport for no gain.

Pick A. The DO loses every platform import: no `unwrapToken`, no `revokeGrant`, no `createClient`. Expiry is computed as request start time plus `expires_in`, taken before the fetch so it is conservative. Store `scope` from the token response. Give the token fetch a ten-second abort signal so a slow issuer cannot pin the DO indefinitely.

**3. Resource dispatch for `/api`**

- A. Always fetch the canonical resource. On the platform the browser's request to `P/api` would fetch `P/api` again. Recursion.
- B. Always in-process. Notes has no `oauthResponse`.
- C. Adapter takes one function `api(request)`. Platform passes in-process dispatch for both owned origins, Notes passes `fetch`.

Pick C. This is the only injected transport, justified by the recursion case. It also covers WebSocket upgrades, since Workers fetch returns 101 responses.

**4. Logout**

- A. RFC 7009 refresh-token revocation. No D1 marker, so cached admissions and live sockets survive KV propagation. Not fail-closed.
- B. Strong logout in the platform adapter only, 7009 for Notes. Two meanings of "log out".
- C. Add `publicSession.logout()`. It calls the existing `revokeGrant` on exactly the grant that authenticated the call, any scope, personal tokens included, and rejects the admin bearer. The DO's `end()` refreshes if the access token is within thirty seconds of expiry, calls `logout()` with a five-second abort signal, deletes tokens regardless, and returns whether revocation succeeded.

Pick C with no 7009 fallback. When the RPC fails on the network, 7009 to the same host fails the same way. When refresh is refused, the grant is already dead. The semantics are then simple. Browser side always ends: cookie cleared, tokens gone. Grant side is one bounded attempt, observable: the adapter logs an unrevoked-logout event with origin only, the grant stays visible and revocable in the console inventory, and live sockets close within thirty seconds through the existing renewal check.

Add one fail-closed rule: when the adapter supplied a session bearer and the resource answered 401, call `end()` and clear the cookie in the same response. Apply the same rule in the server-side session helper. This replaces the current `browserAuthorization` behaviour for grants revoked elsewhere.

**5. Local development client**

- A. Keep in-process `createClient` through a hook. Breaks decision 2.
- B. Relax the provider so a plain http localhost client identifier passes Client ID Metadata Document checks. Needs a fork.
- C. Enable the provider's dynamic registration endpoint only when the issuer origin is http. The DO's `begin` registers over fetch for a local origin. No cleanup, acceptable for a dev-only key space.

Pick C.

**6. Scope changes**

- A. Nothing automatic. Old sessions fail with insufficient scope until the user guesses to log out.
- B. Multi-grant upgrade state in the DO. Rejected already.
- C. In `bearer()`, if the stored scope set differs from the configured set, call `end()` and return null. Next login is the ordinary explicit form.

Pick C. Three lines, no new state, deterministic after a deploy.

**Exact boundaries**

New package, three files:

- `session-do.ts` exports `AppSession`. Config arrives through `begin`: origin, issuer, resource, scopes, client identifier. No env bindings, so any worker can re-export and bind it with its own migration.
- `adapter.ts` exports `appAuth(request, namespace, config)`. Config is issuer, resource, scopes, and the `api` function. It owns the five paths, cookie naming, same-origin checks and the 401 rule, and returns null for everything else. Current cookie and CSRF logic moves unchanged.
- `server.ts` exports `sessionOf(request, namespace, config)` returning the bearer and an RPC factory over a batch session against the resource. Console SSR migrates from `browserSessionOf` to this plus `publicSession.me()`, which likely makes `authorizationForToken` and the adapter's `browserAuthorization` removable. Verify callers before deleting.

Platform additions: `publicSession.logout()`, dev-only registration endpoint, the compat flag. Platform deletions: the DO's provider imports, `userId` and `grantId` from stored sessions, `projectId` from the host record.

Out of scope and unaffected: JWT-verified stateless apps. The DO holds opaque tokens and can hand out a JWT later without changing the adapter.

**Verify before calling it done**

- A deployed probe that exercises login and logout on the platform origin, since the flag's self-fetch behaviour is the single point that can break console login in production.
- Wrangler dev loopback fetch from within the DO.
- Capnweb honours the abort signal on a passed Request. If it does not, wrap the call in a timeout race.
