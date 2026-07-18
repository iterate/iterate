import { describe, expect, test, vi } from "vitest";
import { type IterateAuthConfig, type TokenSet } from "@iterate-com/auth/server";
import {
  oauthStateCookie,
  sessionCookie,
  signedTokenSet as signedTokenSetFor,
  testAuthHandler,
  testAuthMiddleware,
  testTokenSet,
} from "./test-support.ts";

/** This file's deployment shape, baked into every signed token. */
function signedTokenSet(overrides: Partial<TokenSet> = {}) {
  return signedTokenSetFor(config, overrides);
}

const config = {
  issuer: "https://auth.iterate-dev.com/api/auth",
  clientId: "os-local-dev",
  clientSecret: "secret",
  redirectURI: "http://localhost:65455/api/iterate-auth/callback",
  resource: "http://localhost",
} satisfies IterateAuthConfig;

describe("iterate auth login", () => {
  test("canonicalizes loopback aliases before writing the OAuth state cookie", async () => {
    const handler = testAuthHandler(config);

    const response = await handler(
      new Request("http://127.0.0.1:65455/api/iterate-auth/login?return_to=%2Fprojects"),
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      "http://localhost:65455/api/iterate-auth/login?return_to=%2Fprojects",
    );
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  test("writes the OAuth state cookie on the configured callback origin", async () => {
    const handler = testAuthHandler(config);

    const response = await handler(new Request("http://localhost:65455/api/iterate-auth/login"));

    expect(response.status).toBe(302);
    expect(response.headers.get("set-cookie")).toContain("iterate_oauth_state=");

    const location = new URL(response.headers.get("location") ?? "");
    expect(location.origin).toBe("https://auth.iterate-dev.com");
    expect(location.searchParams.get("client_id")).toBe("os-local-dev");
    expect(location.searchParams.get("redirect_uri")).toBe(
      "http://localhost:65455/api/iterate-auth/callback",
    );
    expect(location.searchParams.get("state")).toBeTruthy();
  });

  test.for([
    {
      name: "forwards valid login hints to the auth worker authorization request",
      hint: "google",
      forwarded: "google" as string | null,
    },
    {
      name: "drops unknown login hints from the auth worker authorization request",
      hint: "github",
      forwarded: null,
    },
  ])("$name", async ({ hint, forwarded }) => {
    const handler = testAuthHandler(config);

    const response = await handler(
      new Request(`http://localhost:65455/api/iterate-auth/login?login_hint=${hint}`),
    );

    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location") ?? "");
    expect(location.searchParams.get("login_hint")).toBe(forwarded);
  });

  test("resolves relative return paths against the configured public return origin", async () => {
    const handler = testAuthHandler({
      ...config,
      redirectURI: "https://misha.tunnels.iterate.com/api/iterate-auth/callback",
      logoutReturnToOrigins: ["https://misha.tunnels.iterate.com"],
    });

    const response = await handler(
      new Request("http://127.0.0.1:49572/api/iterate-auth/login?return_to=%2F"),
    );

    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location") ?? "");
    expect(location.searchParams.get("redirect_uri")).toBe(
      "https://misha.tunnels.iterate.com/api/iterate-auth/callback",
    );
    expect(oauthStateCookie(response)).toMatchObject({
      returnTo: "https://misha.tunnels.iterate.com/",
    });
  });

  test("force refreshes session cookies before reading claims", async () => {
    const tokenSet = testTokenSet({ accessTokenExpiresAt: Date.now() + 60 * 60 * 1000 });
    const doRefresh = vi.fn(async (current: TokenSet) => current);
    const handler = testAuthHandler(config, { doRefresh });

    await handler(
      new Request("http://localhost:65455/api/iterate-auth/session?refresh=force", {
        headers: { cookie: sessionCookie(tokenSet) },
      }),
    );

    expect(doRefresh).toHaveBeenCalledTimes(1);
    expect(doRefresh).toHaveBeenCalledWith(tokenSet);
  });

  test("does not refresh non-expiring session cookies by default", async () => {
    const doRefresh = vi.fn(async (current: TokenSet) => current);
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

    expect(doRefresh).not.toHaveBeenCalled();
  });

  test("keeps a still-valid session when forced refresh fails", async () => {
    const signed = await signedTokenSet({
      accessTokenExpiresAt: Date.now() + 60 * 60 * 1000,
    });
    const doRefresh = vi.fn(async () => {
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

    expect(doRefresh).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(200);
    // Served claims are the cookie's old ones — the response says so.
    expect(response.headers.get("x-iterate-auth-stale-refresh")).toBe("1");
    await expect(response.json()).resolves.toMatchObject({
      authenticated: true,
      user: {
        id: "usr_session",
      },
    });
  });

  test("flags a forced refresh on a session with no refresh token (minted sessions)", async () => {
    const signed = await signedTokenSet({
      accessTokenExpiresAt: Date.now() + 60 * 60 * 1000,
      refreshToken: undefined,
    });
    const doRefresh = vi.fn(async (current: TokenSet) => current);
    const handler = testAuthHandler(config, {
      doRefresh,
      jwks: signed.jwks as never,
    });

    const forced = await handler(
      new Request("http://localhost:65455/api/iterate-auth/session?refresh=force", {
        headers: { cookie: sessionCookie(signed.tokenSet) },
      }),
    );

    expect(doRefresh).not.toHaveBeenCalled();
    expect(forced.status).toBe(200);
    expect(forced.headers.get("x-iterate-auth-stale-refresh")).toBe("1");
    await expect(forced.json()).resolves.toMatchObject({ authenticated: true });

    // A plain read is not a refresh request: no flag, no log noise — minted
    // sessions hit this endpoint constantly.
    const plain = await handler(
      new Request("http://localhost:65455/api/iterate-auth/session", {
        headers: { cookie: sessionCookie(signed.tokenSet) },
      }),
    );
    expect(plain.status).toBe(200);
    expect(plain.headers.get("x-iterate-auth-stale-refresh")).toBeNull();
  });

  test("reports non-fatal refresh failures while returning a valid session", async () => {
    const signed = await signedTokenSet({
      accessTokenExpiresAt: Date.now() + 15 * 1000,
    });
    const doRefresh = vi.fn(async () => {
      throw new Error("temporary token endpoint failure");
    });
    const auth = testAuthMiddleware(config, {
      doRefresh,
      jwks: signed.jwks as never,
    });
    const onError = vi.fn();

    const result = await auth.authenticate({
      headers: new Headers({
        cookie: sessionCookie(signed.tokenSet),
      }),
      includeUserInfo: false,
      onError,
    });

    expect(doRefresh).toHaveBeenCalledTimes(1);
    expect(result.session?.user.id).toBe("usr_session");
    expect(onError).toHaveBeenCalledWith({
      reason: "session_refresh_failed",
      error: expect.any(Error),
    });
  });

  test("does not rotate a still-valid session when refresh is disabled", async () => {
    const signed = await signedTokenSet({
      accessTokenExpiresAt: Date.now() + 15 * 1000,
    });
    const doRefresh = vi.fn(async (current: TokenSet) => current);
    const auth = testAuthMiddleware(config, {
      doRefresh,
      jwks: signed.jwks as never,
    });

    const result = await auth.authenticate({
      headers: new Headers({ cookie: sessionCookie(signed.tokenSet) }),
      includeUserInfo: false,
      refresh: "never",
    });

    expect(result.session?.user.id).toBe("usr_session");
    expect(result.responseHeaders.get("set-cookie")).toBeNull();
    expect(doRefresh).not.toHaveBeenCalled();
  });

  test("rejects an expired session without spending its refresh token when refresh is disabled", async () => {
    const signed = await signedTokenSet({
      accessTokenExpiresAt: Date.now() - 60 * 1000,
    });
    const doRefresh = vi.fn(async (current: TokenSet) => current);
    const auth = testAuthMiddleware(config, {
      doRefresh,
      jwks: signed.jwks as never,
    });

    const result = await auth.authenticate({
      headers: new Headers({ cookie: sessionCookie(signed.tokenSet) }),
      includeUserInfo: false,
      refresh: "never",
    });

    expect(result.session).toBeNull();
    expect(result.responseHeaders.get("set-cookie")).toBeNull();
    expect(doRefresh).not.toHaveBeenCalled();
  });

  test("reports session verification failures to the auth caller", async () => {
    const auth = testAuthMiddleware(config);
    const onError = vi.fn();

    const result = await auth.authenticate({
      headers: new Headers({
        cookie: sessionCookie(testTokenSet()),
      }),
      includeUserInfo: false,
      onError,
    });

    expect(result.session).toBeNull();
    expect(onError).toHaveBeenCalledWith({
      reason: "access_token_verify_failed",
      error: expect.any(Error),
    });
  });

  test("refreshes once when cookie token verification fails", async () => {
    const oldSigned = await signedTokenSet();
    const currentSigned = await signedTokenSet();
    const doRefresh = vi.fn(async () => currentSigned.tokenSet);
    const auth = testAuthMiddleware(config, {
      doRefresh,
      jwks: currentSigned.jwks as never,
    });
    const onError = vi.fn();

    const result = await auth.authenticate({
      headers: new Headers({
        cookie: sessionCookie(oldSigned.tokenSet),
      }),
      includeUserInfo: false,
      onError,
    });

    expect(doRefresh).toHaveBeenCalledTimes(1);
    expect(result.session?.user.id).toBe("usr_session");
    expect(result.responseHeaders.get("set-cookie")).toContain("iterate_session=");
    expect(onError).not.toHaveBeenCalled();
  });

  test("returns a rotated cookie when refreshed token verification fails", async () => {
    const oldSigned = await signedTokenSet();
    const refreshedButUnverified = await signedTokenSet();
    const trusted = await signedTokenSet();
    const doRefresh = vi.fn(async () => refreshedButUnverified.tokenSet);
    const auth = testAuthMiddleware(config, {
      doRefresh,
      jwks: trusted.jwks as never,
    });

    const result = await auth.authenticate({
      headers: new Headers({ cookie: sessionCookie(oldSigned.tokenSet) }),
      includeUserInfo: false,
    });

    expect(doRefresh).toHaveBeenCalledOnce();
    expect(result.session).toBeNull();
    expect(result.responseHeaders.get("set-cookie")).toContain("iterate_session=");
  });

  test("refreshes once from the session endpoint when cookie token verification fails", async () => {
    const oldSigned = await signedTokenSet();
    const currentSigned = await signedTokenSet();
    const doRefresh = vi.fn(async () => currentSigned.tokenSet);
    const handler = testAuthHandler(config, {
      doRefresh,
      jwks: currentSigned.jwks as never,
    });

    const response = await handler(
      new Request("http://localhost:65455/api/iterate-auth/session", {
        headers: { cookie: sessionCookie(oldSigned.tokenSet) },
      }),
    );

    expect(doRefresh).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain("iterate_session=");
    await expect(response.json()).resolves.toMatchObject({
      authenticated: true,
      user: { id: "usr_session" },
    });
  });

  test("repairs session endpoint verification after a non-fatal proactive refresh failure", async () => {
    const oldSigned = await signedTokenSet();
    const currentSigned = await signedTokenSet();
    const doRefresh = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporary token endpoint failure"))
      .mockResolvedValueOnce(currentSigned.tokenSet);
    const handler = testAuthHandler(config, {
      doRefresh,
      jwks: currentSigned.jwks as never,
    });

    const response = await handler(
      new Request("http://localhost:65455/api/iterate-auth/session?refresh=force", {
        headers: { cookie: sessionCookie(oldSigned.tokenSet) },
      }),
    );

    expect(doRefresh).toHaveBeenCalledTimes(2);
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain("iterate_session=");
    await expect(response.json()).resolves.toMatchObject({
      authenticated: true,
      user: { id: "usr_session" },
    });
  });

  test("returns unauthenticated from the session endpoint when userinfo fails", async () => {
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

    expect(response.status).toBe(401);
    expect(response.headers.get("set-cookie")).toContain("iterate_session=");
    await expect(response.json()).resolves.toEqual({ authenticated: false });
  });
});
