import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import { withAuthenticationResponseHeaders, type IterateAuthConfig } from "./server.ts";
import type { TokenSet } from "./session.ts";
import {
  oauthStateCookie,
  sessionCookie,
  signedTokenSet as signedTokenSetFor,
  testAuthHandler,
  testAuthMiddleware,
  testTokenSet,
} from "./relying-party-test-support.ts";

/** This file's deployment shape, baked into every signed token. */
function signedTokenSet(overrides: Partial<TokenSet> = {}) {
  return signedTokenSetFor(config, overrides);
}

const config = {
  issuer: "https://auth.iterate-dev.com/api/auth",
  clientId: "os-local-dev",
  clientSecret: "secret",
  jwks: { keys: [] },
  redirectURI: "http://localhost:65455/api/iterate-auth/callback",
  resource: "http://localhost",
} satisfies IterateAuthConfig;

describe("relying-party routes and sessions", () => {
  it("canonicalizes loopback aliases before writing the OAuth state cookie", async () => {
    const handler = testAuthHandler(config);

    const response = await handler(
      new Request("http://127.0.0.1:65455/api/iterate-auth/login?return_to=%2Fprojects"),
    );

    assert.equal(response.status, 302);
    assert.equal(
      response.headers.get("location"),
      "http://localhost:65455/api/iterate-auth/login?return_to=%2Fprojects",
    );
    assert.equal(response.headers.get("set-cookie"), null);
  });

  it("writes the OAuth state cookie on the configured callback origin", async () => {
    const handler = testAuthHandler(config);

    const response = await handler(new Request("http://localhost:65455/api/iterate-auth/login"));

    assert.equal(response.status, 302);
    assert.ok(response.headers.get("set-cookie")?.includes("iterate_oauth_state="));

    const location = new URL(response.headers.get("location") ?? "");
    assert.equal(location.origin, "https://auth.iterate-dev.com");
    assert.equal(location.searchParams.get("client_id"), "os-local-dev");
    assert.equal(
      location.searchParams.get("redirect_uri"),
      "http://localhost:65455/api/iterate-auth/callback",
    );
    assert.ok(location.searchParams.get("state"));
  });

  for (const { name, hint, forwarded } of [
    {
      name: "forwards valid login hints to the auth worker authorization request",
      hint: "google",
      forwarded: "google" as string | null,
    },
    {
      name: "forwards email-address login hints (preview click-and-login deep links)",
      hint: encodeURIComponent("pr123+test@nustom.com"),
      forwarded: "pr123+test@nustom.com",
    },
    {
      name: "drops unknown login hints from the auth worker authorization request",
      hint: "github",
      forwarded: null,
    },
  ]) {
    it(name, async () => {
      const handler = testAuthHandler(config);

      const response = await handler(
        new Request(`http://localhost:65455/api/iterate-auth/login?login_hint=${hint}`),
      );

      assert.equal(response.status, 302);
      const location = new URL(response.headers.get("location") ?? "");
      assert.equal(location.searchParams.get("login_hint"), forwarded);
    });
  }

  for (const { name, hint, forwarded } of [
    {
      name: "forwards slug-shaped project hints (template-carrying login links)",
      hint: "pr2477-template-waiter-chef",
      forwarded: "pr2477-template-waiter-chef" as string | null,
    },
    {
      name: "drops project hints that are not slug-shaped",
      hint: encodeURIComponent("Not A Slug!"),
      forwarded: null,
    },
  ]) {
    it(name, async () => {
      const handler = testAuthHandler(config);

      const response = await handler(
        new Request(`http://localhost:65455/api/iterate-auth/login?project_hint=${hint}`),
      );

      assert.equal(response.status, 302);
      const location = new URL(response.headers.get("location") ?? "");
      assert.equal(location.searchParams.get("project_hint"), forwarded);
    });
  }

  it("asks the authorization server to select an account when sign-in requires a choice", async () => {
    const handler = testAuthHandler(config);

    const response = await handler(
      new Request(
        "http://localhost:65455/api/iterate-auth/login?login_hint=google&prompt=select_account",
      ),
    );

    assert.equal(response.status, 302);
    const location = new URL(response.headers.get("location") ?? "");
    assert.equal(location.searchParams.get("login_hint"), "google");
    assert.equal(location.searchParams.get("prompt"), "select_account");
  });

  it("resolves relative return paths against the configured public return origin", async () => {
    const handler = testAuthHandler({
      ...config,
      redirectURI: "https://misha.tunnels.iterate.com/api/iterate-auth/callback",
      logoutReturnToOrigins: ["https://misha.tunnels.iterate.com"],
    });

    const response = await handler(
      new Request("http://127.0.0.1:49572/api/iterate-auth/login?return_to=%2F"),
    );

    assert.equal(response.status, 302);
    const location = new URL(response.headers.get("location") ?? "");
    assert.equal(
      location.searchParams.get("redirect_uri"),
      "https://misha.tunnels.iterate.com/api/iterate-auth/callback",
    );
    assert.partialDeepStrictEqual(oauthStateCookie(response), {
      returnTo: "https://misha.tunnels.iterate.com/",
    });
  });

  it("force refreshes session cookies before reading claims", async () => {
    const tokenSet = testTokenSet({ accessTokenExpiresAt: Date.now() + 60 * 60 * 1000 });
    const doRefresh = mock.fn(async (current: TokenSet) => current);
    const handler = testAuthHandler(config, { doRefresh });

    await handler(
      new Request("http://localhost:65455/api/iterate-auth/session?refresh=force", {
        headers: { cookie: sessionCookie(tokenSet) },
      }),
    );

    assert.equal(doRefresh.mock.callCount(), 1);
    assert.deepEqual(doRefresh.mock.calls[0]?.arguments, [tokenSet]);
  });

  it("does not refresh non-expiring session cookies by default", async () => {
    const doRefresh = mock.fn(async (current: TokenSet) => current);
    const handler = testAuthHandler(config, { doRefresh });

    await handler(
      new Request("http://localhost:65455/api/iterate-auth/session", {
        headers: {
          cookie: sessionCookie(
            testTokenSet({ accessTokenExpiresAt: Date.now() + 60 * 60 * 1000 }),
          ),
        },
      }),
    );

    assert.equal(doRefresh.mock.callCount(), 0);
  });

  it("keeps a still-valid session when forced refresh fails", async () => {
    const signed = await signedTokenSet({
      accessTokenExpiresAt: Date.now() + 60 * 60 * 1000,
    });
    const doRefresh = mock.fn(async () => {
      throw new Error("temporary token endpoint failure");
    });
    const handler = testAuthHandler(config, {
      doRefresh,
      jwks: signed.jwks as never,
    });

    const response = await handler(
      new Request("http://localhost:65455/api/iterate-auth/session?refresh=force", {
        headers: { cookie: sessionCookie(signed.tokenSet) },
      }),
    );

    assert.equal(doRefresh.mock.callCount(), 1);
    assert.equal(response.status, 200);
    // Served claims are the cookie's old ones — the response says so.
    assert.equal(response.headers.get("x-iterate-auth-stale-refresh"), "1");
    assert.partialDeepStrictEqual(await response.json(), {
      authenticated: true,
      user: {
        id: "usr_session",
      },
    });
  });

  it("flags a forced refresh on a session with no refresh token (minted sessions)", async () => {
    const signed = await signedTokenSet({
      accessTokenExpiresAt: Date.now() + 60 * 60 * 1000,
      refreshToken: undefined,
    });
    const doRefresh = mock.fn(async (current: TokenSet) => current);
    const handler = testAuthHandler(config, {
      doRefresh,
      jwks: signed.jwks as never,
    });

    const forced = await handler(
      new Request("http://localhost:65455/api/iterate-auth/session?refresh=force", {
        headers: { cookie: sessionCookie(signed.tokenSet) },
      }),
    );

    assert.equal(doRefresh.mock.callCount(), 0);
    assert.equal(forced.status, 200);
    assert.equal(forced.headers.get("x-iterate-auth-stale-refresh"), "1");
    assert.partialDeepStrictEqual(await forced.json(), { authenticated: true });

    // A plain read is not a refresh request: no flag, no log noise — minted
    // sessions hit this endpoint constantly.
    const plain = await handler(
      new Request("http://localhost:65455/api/iterate-auth/session", {
        headers: { cookie: sessionCookie(signed.tokenSet) },
      }),
    );
    assert.equal(plain.status, 200);
    assert.equal(plain.headers.get("x-iterate-auth-stale-refresh"), null);
  });

  it("reports non-fatal refresh failures while returning a valid session", async () => {
    const signed = await signedTokenSet({
      accessTokenExpiresAt: Date.now() + 15 * 1000,
    });
    const refreshFailure = new Error("temporary token endpoint failure");
    const doRefresh = mock.fn(async () => {
      throw refreshFailure;
    });
    const auth = testAuthMiddleware(config, {
      doRefresh,
      jwks: signed.jwks as never,
    });
    const onError = mock.fn();

    const result = await auth.authenticate({
      headers: new Headers({
        cookie: sessionCookie(signed.tokenSet),
      }),
      includeUserInfo: false,
      onError,
    });

    assert.equal(doRefresh.mock.callCount(), 1);
    assert.equal(result.session?.user.id, "usr_session");
    assert.equal(onError.mock.callCount(), 1);
    assert.deepEqual(onError.mock.calls[0]?.arguments[0], {
      error: refreshFailure,
      reason: "session_refresh_failed",
    });
  });

  it("keeps session authentication local unless userinfo is requested", async () => {
    const signed = await signedTokenSet();
    const getUserInfo = mock.fn(async () => null);
    const auth = testAuthMiddleware(config, {
      getUserInfo,
      jwks: signed.jwks as never,
    });

    const result = await auth.authenticate({
      headers: new Headers({ cookie: sessionCookie(signed.tokenSet) }),
    });

    assert.equal(result.session?.user.id, "usr_session");
    assert.equal(getUserInfo.mock.callCount(), 0);
  });

  it("does not rotate a still-valid session when refresh is disabled", async () => {
    const signed = await signedTokenSet({
      accessTokenExpiresAt: Date.now() + 15 * 1000,
    });
    const doRefresh = mock.fn(async (current: TokenSet) => current);
    const auth = testAuthMiddleware(config, {
      doRefresh,
      jwks: signed.jwks as never,
    });

    const result = await auth.authenticate({
      headers: new Headers({ cookie: sessionCookie(signed.tokenSet) }),
      includeUserInfo: false,
      refresh: "never",
    });

    assert.equal(result.session?.user.id, "usr_session");
    assert.equal(result.responseHeaders.get("set-cookie"), null);
    assert.equal(doRefresh.mock.callCount(), 0);
  });

  it("does not rotate WebSocket sessions or reconstruct upgrade responses", async () => {
    const signed = await signedTokenSet({
      accessTokenExpiresAt: Date.now() + 15 * 1000,
    });
    const doRefresh = mock.fn(async (current: TokenSet) => current);
    const auth = testAuthMiddleware(config, {
      doRefresh,
      jwks: signed.jwks as never,
    });

    const result = await auth.authenticate({
      headers: new Headers({
        cookie: sessionCookie(signed.tokenSet),
        upgrade: "websocket",
      }),
      includeUserInfo: false,
    });

    assert.equal(result.session?.user.id, "usr_session");
    assert.equal(result.responseHeaders.get("set-cookie"), null);
    assert.equal(doRefresh.mock.callCount(), 0);

    // Fetch's Response constructor rejects status 101 outside a Workers
    // upgrade, so give a real Response the status shape of one. Empty auth
    // headers must preserve the original upgrade response by identity.
    const upgradeResponse = new Response(null);
    Object.defineProperty(upgradeResponse, "status", { value: 101 });
    assert.strictEqual(
      withAuthenticationResponseHeaders(upgradeResponse, result.responseHeaders),
      upgradeResponse,
    );
  });

  it("rejects an expired session without spending its refresh token when refresh is disabled", async () => {
    const signed = await signedTokenSet({
      accessTokenExpiresAt: Date.now() - 60 * 1000,
    });
    const doRefresh = mock.fn(async (current: TokenSet) => current);
    const auth = testAuthMiddleware(config, {
      doRefresh,
      jwks: signed.jwks as never,
    });

    const result = await auth.authenticate({
      headers: new Headers({ cookie: sessionCookie(signed.tokenSet) }),
      includeUserInfo: false,
      refresh: "never",
    });

    assert.equal(result.session, null);
    assert.equal(result.responseHeaders.get("set-cookie"), null);
    assert.equal(doRefresh.mock.callCount(), 0);
  });

  it("reports session verification failures to the auth caller", async () => {
    const auth = testAuthMiddleware(config);
    const onError = mock.fn();

    const result = await auth.authenticate({
      headers: new Headers({
        cookie: sessionCookie(testTokenSet()),
      }),
      includeUserInfo: false,
      onError,
    });

    assert.equal(result.session, null);
    assert.equal(onError.mock.callCount(), 1);
    const event = onError.mock.calls[0]?.arguments[0];
    assert.ok(event?.error instanceof Error);
    assert.deepEqual(event, {
      error: event.error,
      reason: "access_token_verify_failed",
    });
  });

  it("refreshes once when cookie token verification fails", async () => {
    const oldSigned = await signedTokenSet();
    const currentSigned = await signedTokenSet();
    const doRefresh = mock.fn(async () => currentSigned.tokenSet);
    const auth = testAuthMiddleware(config, {
      doRefresh,
      jwks: currentSigned.jwks as never,
    });
    const onError = mock.fn();

    const result = await auth.authenticate({
      headers: new Headers({
        cookie: sessionCookie(oldSigned.tokenSet),
      }),
      includeUserInfo: false,
      onError,
    });

    assert.equal(doRefresh.mock.callCount(), 1);
    assert.equal(result.session?.user.id, "usr_session");
    assert.ok(result.responseHeaders.get("set-cookie")?.includes("iterate_session="));
    assert.equal(onError.mock.callCount(), 0);
  });

  it("returns a rotated cookie when refreshed token verification fails", async () => {
    const oldSigned = await signedTokenSet();
    const refreshedButUnverified = await signedTokenSet();
    const trusted = await signedTokenSet();
    const doRefresh = mock.fn(async () => refreshedButUnverified.tokenSet);
    const auth = testAuthMiddleware(config, {
      doRefresh,
      jwks: trusted.jwks as never,
    });

    const result = await auth.authenticate({
      headers: new Headers({ cookie: sessionCookie(oldSigned.tokenSet) }),
      includeUserInfo: false,
    });

    assert.equal(doRefresh.mock.callCount(), 1);
    assert.equal(result.session, null);
    assert.ok(result.responseHeaders.get("set-cookie")?.includes("iterate_session="));
  });

  it("refreshes once from the session endpoint when cookie token verification fails", async () => {
    const oldSigned = await signedTokenSet();
    const currentSigned = await signedTokenSet();
    const doRefresh = mock.fn(async () => currentSigned.tokenSet);
    const handler = testAuthHandler(config, {
      doRefresh,
      jwks: currentSigned.jwks as never,
    });

    const response = await handler(
      new Request("http://localhost:65455/api/iterate-auth/session", {
        headers: { cookie: sessionCookie(oldSigned.tokenSet) },
      }),
    );

    assert.equal(doRefresh.mock.callCount(), 1);
    assert.equal(response.status, 200);
    assert.ok(response.headers.get("set-cookie")?.includes("iterate_session="));
    assert.partialDeepStrictEqual(await response.json(), {
      authenticated: true,
      user: { id: "usr_session" },
    });
  });

  it("repairs session endpoint verification after a non-fatal proactive refresh failure", async () => {
    const oldSigned = await signedTokenSet();
    const currentSigned = await signedTokenSet();
    let refreshAttempt = 0;
    const doRefresh = mock.fn(async () => {
      refreshAttempt += 1;
      if (refreshAttempt === 1) throw new Error("temporary token endpoint failure");
      return currentSigned.tokenSet;
    });
    const handler = testAuthHandler(config, {
      doRefresh,
      jwks: currentSigned.jwks as never,
    });

    const response = await handler(
      new Request("http://localhost:65455/api/iterate-auth/session?refresh=force", {
        headers: { cookie: sessionCookie(oldSigned.tokenSet) },
      }),
    );

    assert.equal(doRefresh.mock.callCount(), 2);
    assert.equal(response.status, 200);
    assert.ok(response.headers.get("set-cookie")?.includes("iterate_session="));
    assert.partialDeepStrictEqual(await response.json(), {
      authenticated: true,
      user: { id: "usr_session" },
    });
  });

  it("returns unauthenticated from the session endpoint when userinfo fails", async () => {
    const signed = await signedTokenSet();
    const handler = testAuthHandler(config, {
      getUserInfo: async () => {
        throw new Error("userinfo unavailable");
      },
      jwks: signed.jwks as never,
    });

    const response = await handler(
      new Request("http://localhost:65455/api/iterate-auth/session", {
        headers: { cookie: sessionCookie(signed.tokenSet) },
      }),
    );

    assert.equal(response.status, 401);
    assert.ok(response.headers.get("set-cookie")?.includes("iterate_session="));
    assert.deepEqual(await response.json(), { authenticated: false });
  });
});
