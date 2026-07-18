// Auth test crypto + wiring: fake handler/middleware infra, token-set
// builders, the session cookie shape, and a real RS256 signer (Web Crypto,
// no golden strings) so verification paths run against genuinely signed JWTs.

import * as oauth from "oauth4webapi";
import {
  createAuthHandler,
  createAuthMiddleware,
  type IterateAuthConfig,
  type OAuthInfra,
} from "./server.ts";
import type { TokenSet } from "./session.ts";

export function testAuthHandler(
  authConfig: IterateAuthConfig,
  overrides: Partial<OAuthInfra> = {},
) {
  const infra: OAuthInfra = {
    ...baseInfra(authConfig),
    getAuthorizationServer: async () => ({
      issuer: authConfig.issuer ?? "https://auth.iterate-dev.com/api/auth",
      authorization_endpoint: "https://auth.iterate-dev.com/api/auth/oauth2/authorize",
    }),
    toTokenSet: () => {
      throw new Error("not used by login tests");
    },
    ...overrides,
  };

  return createAuthHandler(authConfig, infra);
}

export function testAuthMiddleware(
  authConfig: IterateAuthConfig,
  overrides: Partial<OAuthInfra> = {},
) {
  const infra: OAuthInfra = {
    ...baseInfra(authConfig),
    getAuthorizationServer: async () => {
      throw new Error("not used by middleware tests");
    },
    toTokenSet: () => {
      throw new Error("not used by middleware tests");
    },
    ...overrides,
  };

  return createAuthMiddleware(authConfig, infra);
}

export function testTokenSet(overrides: Partial<TokenSet> = {}): TokenSet {
  return {
    accessToken: "not-a-real-access-token",
    accessTokenExpiresAt: Date.now() + 60 * 60 * 1000,
    idToken: "not-a-real-id-token",
    refreshToken: "refresh-token-1",
    tokenType: "bearer",
    ...overrides,
  };
}

export function sessionCookie(tokenSet: TokenSet) {
  return `iterate_session=${encodeURIComponent(JSON.stringify(tokenSet))}`;
}

export function oauthStateCookie(response: Response) {
  const match = /(?:^|;\s*)iterate_oauth_state=([^;]+)/u.exec(
    response.headers.get("set-cookie") ?? "",
  );
  if (!match) throw new Error("Missing iterate_oauth_state cookie");
  return JSON.parse(decodeURIComponent(match[1]!)) as { returnTo?: string };
}

/** A token set whose access/id tokens are REALLY signed (fresh RSA keypair);
 * hand `jwks` to the handler/middleware infra so verification succeeds. */
export async function signedTokenSet(
  authConfig: IterateAuthConfig,
  overrides: Partial<TokenSet> = {},
) {
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
    aud: authConfig.resource,
    exp: expiresAt,
    iat: now,
    iss: authConfig.issuer,
    scope: "openid profile email offline_access",
    sub: "usr_session",
  });
  const idToken = await signJwt(keyPair.privateKey, {
    aud: authConfig.clientId,
    email: "session@example.com",
    exp: expiresAt,
    iat: now,
    iss: authConfig.issuer,
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

function baseInfra(
  authConfig: IterateAuthConfig,
): Omit<OAuthInfra, "getAuthorizationServer" | "toTokenSet"> {
  return {
    issuerURL: new URL(authConfig.issuer ?? "https://auth.iterate-dev.com/api/auth"),
    jwks: async () => {
      throw new Error("test JWKS not configured");
    },
    oauthClient: { client_id: authConfig.clientId },
    clientAuth: oauth.ClientSecretBasic(authConfig.clientSecret),
    insecure: false,
    secureCookies: false,
    httpOptions: () => undefined,
    doRefresh: async () => null,
    getUserInfo: async () => null,
    cookieOpts: () => ({ httpOnly: true, path: "/", sameSite: "Lax", secure: false }) as const,
    resource: () => "http://localhost",
    audiences: () => ["http://localhost"],
  };
}
