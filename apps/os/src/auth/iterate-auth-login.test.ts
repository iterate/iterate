import { describe, expect, it, vi } from "vitest";
import {
  createAuthHandler,
  createAuthMiddleware,
  type IterateAuthConfig,
  type TokenSet,
} from "@iterate-com/auth/server";

const config = {
  issuer: "https://auth.iterate-dev.com/api/auth",
  clientId: "os-local-dev",
  clientSecret: "secret",
  redirectURI: "http://localhost:65455/api/iterate-auth/callback",
  resource: "http://localhost",
} satisfies IterateAuthConfig;

describe("iterate auth login", () => {
  it("canonicalizes loopback aliases before writing the OAuth state cookie", async () => {
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

  it("writes the OAuth state cookie on the configured callback origin", async () => {
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

  it("forwards valid login hints to the auth worker authorization request", async () => {
    const handler = testAuthHandler(config);

    const response = await handler(
      new Request("http://localhost:65455/api/iterate-auth/login?login_hint=google"),
    );

    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location") ?? "");
    expect(location.searchParams.get("login_hint")).toBe("google");
  });

  it("drops unknown login hints from the auth worker authorization request", async () => {
    const handler = testAuthHandler(config);

    const response = await handler(
      new Request("http://localhost:65455/api/iterate-auth/login?login_hint=github"),
    );

    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location") ?? "");
    expect(location.searchParams.get("login_hint")).toBeNull();
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

    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location") ?? "");
    expect(location.searchParams.get("redirect_uri")).toBe(
      "https://misha.tunnels.iterate.com/api/iterate-auth/callback",
    );
    expect(oauthStateCookie(response)).toMatchObject({
      returnTo: "https://misha.tunnels.iterate.com/",
    });
  });

  it("force refreshes session cookies before reading claims", async () => {
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

  it("does not refresh non-expiring session cookies by default", async () => {
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

  it("keeps a still-valid session when forced refresh fails", async () => {
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
    await expect(response.json()).resolves.toMatchObject({
      authenticated: true,
      user: {
        id: "usr_session",
      },
    });
  });

  it("reports non-fatal refresh failures while returning a valid session", async () => {
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

  it("reports session verification failures to the auth caller", async () => {
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

  it("refreshes once when cookie token verification fails", async () => {
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

  it("refreshes once from the session endpoint when cookie token verification fails", async () => {
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

  it("repairs session endpoint verification after a non-fatal proactive refresh failure", async () => {
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

    expect(response.status).toBe(401);
    expect(response.headers.get("set-cookie")).toContain("iterate_session=");
    await expect(response.json()).resolves.toEqual({ authenticated: false });
  });
});

function testAuthHandler(
  authConfig: IterateAuthConfig,
  overrides: Partial<Parameters<typeof createAuthHandler>[1]> = {},
) {
  const infra = {
    issuerURL: new URL(authConfig.issuer ?? "https://auth.iterate-dev.com/api/auth"),
    jwks: {},
    oauthClient: { client_id: authConfig.clientId },
    clientAuth: {},
    insecure: false,
    secureCookies: false,
    getAuthorizationServer: async () => ({
      issuer: authConfig.issuer,
      authorization_endpoint: "https://auth.iterate-dev.com/api/auth/oauth2/authorize",
    }),
    httpOptions: () => undefined,
    toTokenSet: () => {
      throw new Error("not used by login tests");
    },
    doRefresh: async () => null,
    getUserInfo: async () => null,
    cookieOpts: () => ({ httpOnly: true, path: "/", sameSite: "Lax", secure: false }) as const,
    resource: () => "http://localhost",
    audiences: () => ["http://localhost"],
    ...overrides,
  } as unknown as Parameters<typeof createAuthHandler>[1];

  return createAuthHandler(authConfig, infra).handler;
}

function testAuthMiddleware(
  authConfig: IterateAuthConfig,
  overrides: Partial<Parameters<typeof createAuthMiddleware>[1]> = {},
) {
  const infra = {
    issuerURL: new URL(authConfig.issuer ?? "https://auth.iterate-dev.com/api/auth"),
    jwks: {},
    oauthClient: { client_id: authConfig.clientId },
    clientAuth: {},
    insecure: false,
    secureCookies: false,
    getAuthorizationServer: async () => {
      throw new Error("not used by middleware tests");
    },
    httpOptions: () => undefined,
    toTokenSet: () => {
      throw new Error("not used by middleware tests");
    },
    doRefresh: async () => null,
    getUserInfo: async () => null,
    cookieOpts: () => ({ httpOnly: true, path: "/", sameSite: "Lax", secure: false }) as const,
    resource: () => "http://localhost",
    audiences: () => ["http://localhost"],
    ...overrides,
  } as unknown as Parameters<typeof createAuthMiddleware>[1];

  return createAuthMiddleware(authConfig, infra);
}

function testTokenSet(overrides: Partial<TokenSet> = {}): TokenSet {
  return {
    accessToken: "not-a-real-access-token",
    accessTokenExpiresAt: Date.now() + 60 * 60 * 1000,
    idToken: "not-a-real-id-token",
    refreshToken: "refresh-token-1",
    tokenType: "bearer",
    ...overrides,
  };
}

function sessionCookie(tokenSet: TokenSet) {
  return `iterate_session=${encodeURIComponent(JSON.stringify(tokenSet))}`;
}

function oauthStateCookie(response: Response) {
  const match = /(?:^|;\s*)iterate_oauth_state=([^;]+)/u.exec(
    response.headers.get("set-cookie") ?? "",
  );
  if (!match) throw new Error("Missing iterate_oauth_state cookie");
  return JSON.parse(decodeURIComponent(match[1]!)) as { returnTo?: string };
}

async function signedTokenSet(overrides: Partial<TokenSet> = {}) {
  const keyPair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = Math.floor(
    (overrides.accessTokenExpiresAt ?? Date.now() + 60 * 60 * 1000) / 1000,
  );
  const accessToken = await signJwt(keyPair.privateKey, {
    aud: config.resource,
    exp: expiresAt,
    iat: now,
    iss: config.issuer,
    scope: "openid profile email offline_access",
    sub: "usr_session",
  });
  const idToken = await signJwt(keyPair.privateKey, {
    aud: config.clientId,
    email: "session@example.com",
    exp: expiresAt,
    iat: now,
    iss: config.issuer,
    sub: "usr_session",
  });

  return {
    jwks: keyPair.publicKey,
    tokenSet: testTokenSet({
      accessToken,
      accessTokenExpiresAt: expiresAt * 1000,
      idToken,
      ...overrides,
    }),
  };
}

async function signJwt(privateKey: CryptoKey, payload: Record<string, unknown>) {
  const encodedHeader = base64UrlEncode(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const input = `${encodedHeader}.${encodedPayload}`;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    privateKey,
    new TextEncoder().encode(input),
  );
  return `${input}.${base64UrlEncode(signature)}`;
}

function base64UrlEncode(value: string | ArrayBuffer) {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
}
