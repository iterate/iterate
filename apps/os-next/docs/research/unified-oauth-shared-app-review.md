# Shared app authentication review

Reviewer: Claude Fable 5.1, effort xhigh; canonical model verified in CLI output. Read-only review.

Three blockers, a handful of small fixes, and the architecture otherwise holds. The DO-per-browser session, the probe-then-batch logout, the explicit POST scope upgrade, and the consent page staying a server function are each the smallest correct option. Details below, with the exact edits.

## Blockers

**1. The login redirect never leaves the SPA.** In `browser.ts`, `connect` throws `redirect({ href: "/.auth/login?..." })`. TanStack only performs a document navigation when the href parses as an absolute URL. A relative path is treated as an in-router location, so the client renders not-found instead of reaching the worker. Fix:

```ts
const login = new URL(
  `/.auth/login?${new URLSearchParams({ next, scope: scopes.join(" ") })}`,
  window.location.origin,
).href;
```

**2. Transient provider errors log the browser out on project hosts.** `authorizationForToken` returns null whenever the admission handler did not run, including a provider 5xx or KV failure. `browserAuthorization` treats every null as a verified 401 and discards the session. The `/api` and `/.auth/login` paths already distinguish 401 from failure. Make the third path match:

```ts
const response = await new OAuthProvider(providerOptions(env, admission)).fetch(
  apiRequest,
  env,
  ctx,
);
if (response.status !== 204 && response.status !== 401)
  throw new Error(`Token admission failed (${response.status})`);
return authorization as Authorization | null;
```

**3. Host scopes are a default, not a ceiling.** "Notes gets iterate only" is a client convention. Any link to `/.auth/login?scope=iterate account` on a project host lets userspace request account permission for that host's cookie session. The consent page discloses it, but the host policy should be enforced server-side. Add after the scope parse in `appAuth`:

```ts
if (!parsed.data.every((scope) => (config.scopes ?? []).includes(scope)))
  return new Response("Unsupported permission", { status: 400 });
```

Rename the field comment to "allowed and default scopes". The console config already lists both scopes, so `_auth.tsx` is unaffected.

## Smaller fixes

- **Throwing inside `blockConcurrencyWhile` resets the DO.** Every throw in `begin`, `#exchange` and `end` runs under it. Workers terminates and resets the object on a thrown callback, failing other tabs' in-flight calls with an unrelated error. Dropping the wrapper for a shared refresh promise does not cover the duplicate-callback race in `complete`, where a second exchange of the single-use code would clear the fresh session. Keep the wrapper and stop it throwing:

```ts
#serial<T>(fn: () => Promise<T>): Promise<T> {
  return this.ctx.blockConcurrencyWhile(() => fn().then((value) => ({ value }), (error) => ({ error })))
    .then((result) => { if ("error" in result) throw result.error; return result.value; });
}
```

Use it in place of `this.ctx.blockConcurrencyWhile` in the four public methods. In the same file, guard the refusal parse with `await response.json().catch(() => null)` so an HTML 502 body surfaces the status message rather than a JSON parse error.

- **Malformed `resource` returns 500 from `/authorize`.** `parseAuthorization` calls `new URL(resource)` on client input. Prefix the check with `!URL.canParse(resource) ||` so it becomes `invalid_target`.

- **Dead code and stale comments.** `deadline` is a required positive integer, so the `grant.deadline &&` guard in `authorizationOf` and the ternary in `tokenExchangeCallback` are dead. The `exchangeToken` doc says the browser DO uses it, but the DO uses the public token endpoint. The twelve-line header on `authorize.tsx` references files and names that no longer exist. Trim all three.

- **`Grants.end` can skip the inventory scan more often.** Both writers of `oauth_activity` only record admitted or owned grants, so any existing row proves ownership. Change `if (!marker?.revoked_at)` to `if (!marker)`.

- **Verify HTTP batch teardown.** In `rpcResponse`, the WebSocket path calls `teardown.disposeAll()`, but the HTTP batch path never does. Confirm the Session root's dispose covers it, or dispose after the batch response resolves for non-upgrade requests.

## Proof through the public API only

- Deploy the standalone Notes worker against the real issuer. Assert the full sequence: login redirect is a document navigation, callback 303s to `next`, an empty `POST /api` is 200, WebSocket `info().scopes` equals iterate only, and `/.auth/login?scope=iterate account` is 400.
- After `POST /.auth/logout` on Notes, assert the D1 marker is set, the old bearer gets 401 at `/api`, and the response cleared the cookie.
- Repeat logout on the console origin. This proves the DO's public fetch to its own hostname works under the strictly-public fetch flag.
- Stub the resource to return 503 during logout. Assert a 503 response, the cookie untouched, and the DO still holding an active session.
- Send a callback without `iss`, and with a mismatched `state`. Both must be 400. The passing happy path above proves the pinned provider emits `iss`.
- Stub the provider gate to 500 during `browserAuthorization`. Assert the request fails without discarding the session. A real 401 must still discard.

## Disposition

Applied the navigation fix using TanStack's explicit `reloadDocument`, status classification in provider admission, serialized errors without Durable Object reset, invalid-resource classification, deadline simplification, activity-based ownership, and explicit HTTP batch teardown (the pinned Cap'n Web source does not dispose the root there).

The proposed app-host scope ceiling is not part of the chosen authority model. Account actions require explicit issuer consent; the user wants a userspace dashboard clone able to use the same API. An app can request `account`, and a user can decline. A client-side or app-adapter ceiling would also not prevent a public client from requesting a scope directly at the issuer. Renamed the adapter option to `defaultScopes` to make its role clear. Notes requests `iterate`; it has no account capability on that grant. Project reach remains capped by the managed host's project, including when `account` is granted.
