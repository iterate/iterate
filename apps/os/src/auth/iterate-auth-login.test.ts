import { describe, expect, it, vi } from "vitest";
import { createAuthHandler, type IterateAuthConfig, type TokenSet } from "@iterate-com/auth/server";

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
