import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { parse, serialize } from "hono/utils/cookie";
import { createRemoteJWKSet, jwtVerify } from "jose";
import * as oauth from "oauth4webapi";
import { z } from "zod/v4";

const DEFAULT_ISSUER = "https://auth.iterate.com/api/auth";
const SCOPES = ["openid", "profile", "email", "offline_access"] as const;
const REFRESH_SKEW_MS = 30_000;

export type IterateAuthConfig = {
  issuer?: string;
  clientId: string;
  clientSecret: string;
  redirectURI: string;
  cookiePrefix?: string;
  authHandlerBasePath?: string;
};

const TokenSet = z.object({
  accessToken: z.string(),
  accessTokenExpiresAt: z.number(),
  idToken: z.string(),
  refreshToken: z.string().optional(),
  scope: z.string().optional(),
  tokenType: z.string(),
});

export type TokenSet = z.infer<typeof TokenSet>;

const IdTokenClaims = z.looseObject({
  sub: z.string(),
  email: z.string(),
  name: z.string().optional(),
  picture: z.string().optional(),
  given_name: z.string().optional(),
  family_name: z.string().optional(),
  email_verified: z.boolean().optional(),
  iss: z.string(),
  aud: z.string(),
  iat: z.number(),
  exp: z.number(),
});

const AccessTokenClaims = z.looseObject({
  sub: z.string(),
  scope: z.string(),
  sid: z.string().optional(),
  azp: z.string().optional(),
  iss: z.string(),
  aud: z.union([z.string(), z.array(z.string())]),
  iat: z.number(),
  exp: z.number(),
});

export type IdTokenClaims = z.infer<typeof IdTokenClaims>;
export type AccessTokenClaims = z.infer<typeof AccessTokenClaims>;

export type AuthUser = {
  id: string;
  email: string;
  name?: string;
  picture?: string;
  givenName?: string;
  familyName?: string;
  emailVerified?: boolean;
};

export type AuthSession = {
  expiresAt: number;
  scope: string;
  sessionId?: string;
};

export type AuthenticatedSession = {
  user: AuthUser;
  session: AuthSession;
  tokenClaims: {
    accessToken: AccessTokenClaims;
    idToken: IdTokenClaims;
  };
};

function buildAuthenticatedSession(
  accessToken: AccessTokenClaims,
  idToken: IdTokenClaims,
): AuthenticatedSession {
  return {
    user: {
      id: idToken.sub,
      email: idToken.email,
      name: idToken.name,
      picture: idToken.picture,
      givenName: idToken.given_name,
      familyName: idToken.family_name,
      emailVerified: idToken.email_verified,
    },
    session: {
      expiresAt: accessToken.exp,
      scope: accessToken.scope,
      sessionId: accessToken.sid,
    },
    tokenClaims: { accessToken, idToken },
  };
}

export type SessionResponse =
  | { authenticated: false }
  | ({ authenticated: true } & AuthenticatedSession);

const OAuthState = z.object({
  nonce: z.string(),
  state: z.string(),
  verifier: z.string(),
});

type OAuthState = z.infer<typeof OAuthState>;

type JWKS = ReturnType<typeof createRemoteJWKSet>;

type OAuthInfra = {
  issuerURL: URL;
  jwks: JWKS;
  oauthClient: oauth.Client;
  clientAuth: ReturnType<typeof oauth.ClientSecretBasic>;
  insecure: boolean;
  secureCookies: boolean;
  getAuthorizationServer: () => Promise<oauth.AuthorizationServer>;
  httpOptions: () => { [oauth.allowInsecureRequests]: true } | undefined;
  toTokenSet: (token: oauth.TokenEndpointResponse, existing?: TokenSet | null) => TokenSet;
  doRefresh: (tokenSet: TokenSet) => Promise<TokenSet | null>;
  cookieOpts: () => { httpOnly: true; path: string; sameSite: "Lax"; secure: boolean };
};

function createOAuthInfra(config: IterateAuthConfig, jwks: JWKS): OAuthInfra {
  const issuerURL = new URL(config.issuer ?? DEFAULT_ISSUER);
  const oauthClient: oauth.Client = { client_id: config.clientId };
  const clientAuth = oauth.ClientSecretBasic(config.clientSecret);
  const insecure = issuerURL.protocol === "http:";
  const secureCookies = new URL(config.redirectURI).protocol === "https:";
  const discoveryURL = `${issuerURL.href}/.well-known/openid-configuration`;

  let _as: oauth.AuthorizationServer | undefined;

  function httpOptions() {
    if (!insecure) return undefined;
    return { [oauth.allowInsecureRequests]: true } as const;
  }

  function cookieOpts() {
    return { httpOnly: true, path: "/", sameSite: "Lax", secure: secureCookies } as const;
  }

  function toTokenSet(token: oauth.TokenEndpointResponse, existing?: TokenSet | null): TokenSet {
    return {
      accessToken: token.access_token,
      accessTokenExpiresAt: Date.now() + (token.expires_in ?? 300) * 1000,
      idToken: token.id_token ?? existing?.idToken ?? "", // TODO: this is never a case, but types don't known this, we should make this better
      refreshToken: token.refresh_token ?? existing?.refreshToken,
      scope: token.scope ?? existing?.scope,
      tokenType: token.token_type,
    };
  }

  async function getAuthorizationServer() {
    if (_as) return _as;
    let response: Response;
    try {
      response = await oauth.discoveryRequest(issuerURL, {
        [oauth.allowInsecureRequests]: insecure,
      });
    } catch (cause) {
      throw new Error(`Failed to fetch OIDC discovery from ${discoveryURL}`, { cause });
    }
    try {
      _as = await oauth.processDiscoveryResponse(issuerURL, response);
    } catch (cause) {
      throw new Error(
        `Invalid OIDC discovery response from ${discoveryURL} (HTTP ${response.status})`,
        { cause },
      );
    }
    return _as;
  }

  async function doRefresh(tokenSet: TokenSet): Promise<TokenSet | null> {
    if (!tokenSet.refreshToken) return null;
    const as = await getAuthorizationServer();
    const response = await oauth.refreshTokenGrantRequest(
      as,
      oauthClient,
      clientAuth,
      tokenSet.refreshToken,
      {
        ...httpOptions(),
        additionalParameters: { resource: issuerURL.href },
      },
    );
    const result = await oauth.processRefreshTokenResponse(as, oauthClient, response);
    return toTokenSet(result, tokenSet);
  }

  return {
    issuerURL,
    jwks,
    oauthClient,
    clientAuth,
    insecure,
    secureCookies,
    getAuthorizationServer,
    httpOptions,
    toTokenSet,
    doRefresh,
    cookieOpts,
  };
}

export type AuthenticateResult = {
  session: AuthenticatedSession | null;
  responseHeaders: Headers;
};

export function createAuthMiddleware(config: IterateAuthConfig, infra: OAuthInfra) {
  const prefix = config.cookiePrefix ?? "iterate";
  const SESSION_COOKIE = `${prefix}_session`;
  const issuer = new URL(config.issuer ?? DEFAULT_ISSUER).href;
  const { jwks, doRefresh, cookieOpts } = infra;

  function serializeSessionCookie(tokenSet: TokenSet): string {
    const expires = tokenSet.refreshToken
      ? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
      : new Date(tokenSet.accessTokenExpiresAt);
    return serialize(SESSION_COOKIE, JSON.stringify(tokenSet), { ...cookieOpts(), expires });
  }

  return {
    async authenticate({ headers }: { headers: Headers }): Promise<AuthenticateResult> {
      const cookieJar = parse(headers.get("Cookie") ?? "");
      if (!cookieJar) return { session: null, responseHeaders: new Headers() };

      let tokenSet: TokenSet;
      try {
        tokenSet = TokenSet.parse(JSON.parse(cookieJar[SESSION_COOKIE]));
      } catch {
        return { session: null, responseHeaders: new Headers() };
      }

      if (!tokenSet.idToken) return { session: null, responseHeaders: new Headers() };

      let refreshed = false;
      try {
        if (tokenSet.accessTokenExpiresAt <= Date.now() + REFRESH_SKEW_MS) {
          const newTokenSet = await doRefresh(tokenSet);
          if (!newTokenSet) return { session: null, responseHeaders: new Headers() };
          tokenSet = newTokenSet;
          refreshed = true;
        }
      } catch {
        return { session: null, responseHeaders: new Headers() };
      }

      try {
        const { payload: rawAccessToken } = await jwtVerify(tokenSet.accessToken, jwks, {
          issuer,
          audience: issuer,
        });
        const { payload: rawIdToken } = await jwtVerify(tokenSet.idToken, jwks, {
          issuer,
          audience: config.clientId,
        });

        const accessToken = AccessTokenClaims.parse(rawAccessToken);
        const idToken = IdTokenClaims.parse(rawIdToken);

        const responseHeaders = new Headers();
        if (refreshed) {
          responseHeaders.set("Set-Cookie", serializeSessionCookie(tokenSet));
        }

        return { session: buildAuthenticatedSession(accessToken, idToken), responseHeaders };
      } catch {
        return { session: null, responseHeaders: new Headers() };
      }
    },
  };
}

export function createAuthHandler(config: IterateAuthConfig, infra: OAuthInfra) {
  const { issuerURL, jwks, oauthClient, clientAuth } = infra;
  const { getAuthorizationServer, httpOptions, toTokenSet, doRefresh, cookieOpts } = infra;
  const prefix = config.cookiePrefix ?? "iterate";
  const SESSION_COOKIE = `${prefix}_session`;
  const STATE_COOKIE = `${prefix}_oauth_state`;

  function getTokenSet(c: Context): TokenSet | null {
    const value = getCookie(c, SESSION_COOKIE);
    if (!value) return null;
    try {
      return TokenSet.parse(JSON.parse(value));
    } catch {
      return null;
    }
  }

  function writeCookie(c: Context, tokenSet: TokenSet) {
    const expires = tokenSet.refreshToken
      ? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
      : new Date(tokenSet.accessTokenExpiresAt);
    setCookie(c, SESSION_COOKIE, JSON.stringify(tokenSet), { ...cookieOpts(), expires });
  }

  function readOAuthState(c: Context): OAuthState {
    const value = getCookie(c, STATE_COOKIE);
    if (!value) throw new Error("Missing OAuth state cookie");
    return OAuthState.parse(JSON.parse(value));
  }

  const app = new Hono().basePath(config.authHandlerBasePath ?? "/api/iterate-auth");

  app.get("/login", async (c) => {
    const as = await getAuthorizationServer();
    if (!as.authorization_endpoint) throw new Error("No authorization_endpoint in server metadata");

    const state = oauth.generateRandomState();
    const verifier = oauth.generateRandomCodeVerifier();
    const nonce = oauth.generateRandomNonce();
    const challenge = await oauth.calculatePKCECodeChallenge(verifier);

    const url = new URL(as.authorization_endpoint);
    url.searchParams.set("client_id", config.clientId);
    url.searchParams.set("redirect_uri", config.redirectURI);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", SCOPES.join(" "));
    url.searchParams.set("state", state);
    url.searchParams.set("nonce", nonce);
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");

    setCookie(c, STATE_COOKIE, JSON.stringify({ nonce, state, verifier } satisfies OAuthState), {
      ...cookieOpts(),
      maxAge: 10 * 60,
    });

    return c.redirect(url.toString());
  });

  app.get("/callback", async (c) => {
    const as = await getAuthorizationServer();
    const requestURL = new URL(c.req.url);

    let oauthState: OAuthState;
    try {
      oauthState = readOAuthState(c);
    } catch {
      return c.text("Invalid OAuth state", 400);
    }

    let validatedParams: URLSearchParams;
    try {
      validatedParams = oauth.validateAuthResponse(
        as,
        oauthClient,
        requestURL.searchParams,
        oauthState.state,
      );
    } catch {
      return c.redirect(`${requestURL.origin}/?error=invalid_auth_response`);
    }

    let tokenResponse: oauth.TokenEndpointResponse;
    try {
      const response = await oauth.authorizationCodeGrantRequest(
        as,
        oauthClient,
        clientAuth,
        validatedParams,
        config.redirectURI,
        oauthState.verifier,
        {
          ...httpOptions(),
          additionalParameters: { resource: issuerURL.href },
        },
      );
      tokenResponse = await oauth.processAuthorizationCodeResponse(as, oauthClient, response, {
        expectedNonce: oauthState.nonce,
      });
    } catch (error) {
      console.error("OAuth callback error:", error);
      const message = error instanceof Error ? error.message : String(error);
      return c.text(`OAuth callback exchange failed: ${message}`, 502);
    }

    writeCookie(c, toTokenSet(tokenResponse));
    deleteCookie(c, STATE_COOKIE, cookieOpts());
    return c.redirect(`${requestURL.origin}/`);
  });

  app.get("/session", async (c) => {
    let tokenSet: TokenSet | null;
    try {
      tokenSet = getTokenSet(c);
      if (tokenSet && tokenSet.accessTokenExpiresAt <= Date.now() + REFRESH_SKEW_MS) {
        tokenSet = await doRefresh(tokenSet);
      }
    } catch {
      deleteCookie(c, SESSION_COOKIE, cookieOpts());
      return c.json({ authenticated: false } satisfies SessionResponse, 401);
    }

    if (!tokenSet || !tokenSet.idToken) {
      return c.json({ authenticated: false } satisfies SessionResponse);
    }

    try {
      const { payload: rawAccessToken } = await jwtVerify(tokenSet.accessToken, jwks, {
        issuer: issuerURL.href,
        audience: issuerURL.href,
      });
      const { payload: rawIdToken } = await jwtVerify(tokenSet.idToken, jwks, {
        issuer: issuerURL.href,
        audience: config.clientId,
      });

      const accessToken = AccessTokenClaims.parse(rawAccessToken);
      const idToken = IdTokenClaims.parse(rawIdToken);

      writeCookie(c, tokenSet);
      return c.json({
        authenticated: true,
        ...buildAuthenticatedSession(accessToken, idToken),
      } satisfies SessionResponse);
    } catch {
      deleteCookie(c, SESSION_COOKIE, cookieOpts());
      return c.json({ authenticated: false } satisfies SessionResponse, 401);
    }
  });

  app.post("/logout", async (c) => {
    const tokenSet = getTokenSet(c);
    deleteCookie(c, SESSION_COOKIE, cookieOpts());
    deleteCookie(c, STATE_COOKIE, cookieOpts());

    if (tokenSet?.refreshToken) {
      try {
        const as = await getAuthorizationServer();
        const revokeResponse = await oauth.revocationRequest(
          as,
          oauthClient,
          clientAuth,
          tokenSet.refreshToken,
          httpOptions(),
        );
        await oauth.processRevocationResponse(revokeResponse);
      } catch {
        // Ignore revoke failures during logout.
      }
    }

    return c.redirect("/");
  });

  return {
    handler(request: Request): Response | Promise<Response> {
      return app.fetch(request);
    },
  };
}

export function createIterateAuth(config: IterateAuthConfig) {
  if (!config.clientId || !config.clientSecret || !config.redirectURI) {
    throw new Error(
      "Missing required OAuth client configuration: clientId, clientSecret, and redirectURI are required",
    );
  }

  const issuer = config.issuer ?? DEFAULT_ISSUER;
  const jwks = createRemoteJWKSet(new URL(`${issuer}/jwks`));
  const infra = createOAuthInfra(config, jwks);

  const routes = createAuthHandler(config, infra);
  const middleware = createAuthMiddleware(config, infra);

  return {
    handler: routes.handler,
    authenticate: middleware.authenticate,
  };
}
