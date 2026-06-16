import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { parse, serialize } from "hono/utils/cookie";
import { createLocalJWKSet, createRemoteJWKSet, jwtVerify, type JSONWebKeySet } from "jose";
import * as oauth from "oauth4webapi";
import { z } from "zod/v4";
import {
  ITERATE_ACTIVE_ORGANIZATION_ID_CLAIM,
  ITERATE_ACCESS_TOKEN_ORGANIZATIONS_CLAIM,
  ITERATE_ACCESS_TOKEN_PROJECTS_CLAIM,
  ITERATE_IS_ADMIN_CLAIM,
  ITERATE_ORGANIZATIONS_CLAIM,
  IterateAuthAccessTokenOrganizationClaim,
  IterateAuthOrganizationClaim,
  IterateAuthProjectClaim,
  ITERATE_ROLE_CLAIM,
  type IterateAuthOrganizationClaim as IterateAuthOrganizationClaimType,
  type IterateAuthProjectClaim as IterateAuthProjectClaimType,
} from "@iterate-com/shared/auth-claims";

const DEFAULT_ISSUER = "https://auth.iterate.com/api/auth";
export const DEFAULT_AUTH_HANDLER_BASE_PATH = "/api/iterate-auth";
const SCOPES = ["openid", "profile", "email", "offline_access"] as const;
const REFRESH_SKEW_MS = 30_000;

/**
 * Collapses concurrent calls keyed by the same string into a single in-flight
 * promise. The OAuth refresh-token grant rotates the refresh token and revokes
 * the whole family if a rotated token is presented twice, so two requests
 * carrying the same session cookie must not both hit the token endpoint —
 * otherwise the loser's "reuse" nukes the session and logs the user out. The
 * entry is removed once settled so the next (rotated) token starts fresh.
 */
export function createSingleFlight<T>(): (key: string, fn: () => Promise<T>) => Promise<T> {
  const inFlight = new Map<string, Promise<T>>();
  return (key, fn) => {
    const existing = inFlight.get(key);
    if (existing) return existing;
    // Clear inside the awaited promise's own finally so the entry is gone the
    // moment callers observe the result — the next (rotated-token) cycle starts
    // clean, while everyone racing the current cycle still shares this flight.
    const flight = (async () => {
      try {
        return await fn();
      } finally {
        inFlight.delete(key);
      }
    })();
    inFlight.set(key, flight);
    return flight;
  };
}

export type IterateAuthConfig = {
  issuer?: string;
  clientId: string;
  clientSecret: string;
  redirectURI: string;
  jwks?: JSONWebKeySet;
  resource?: string | string[];
  logoutReturnToOrigins?: string[];
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
  [ITERATE_IS_ADMIN_CLAIM]: z.boolean().optional(),
  [ITERATE_ROLE_CLAIM]: z.string().nullable().optional(),
});

const AccessTokenClaims = z.looseObject({
  sub: z.string(),
  scope: z.string(),
  scopes: z.array(z.string()).optional(),
  sid: z.string().optional(),
  azp: z.string().optional(),
  iss: z.string(),
  aud: z.union([z.string(), z.array(z.string())]),
  iat: z.number(),
  exp: z.number(),
  [ITERATE_ACCESS_TOKEN_ORGANIZATIONS_CLAIM]: z
    .array(IterateAuthAccessTokenOrganizationClaim)
    .optional(),
  [ITERATE_ACCESS_TOKEN_PROJECTS_CLAIM]: z.array(IterateAuthProjectClaim).optional(),
});

const UserInfoClaims = z.looseObject({
  sub: z.string(),
  [ITERATE_ACTIVE_ORGANIZATION_ID_CLAIM]: z.string().nullable().optional(),
  [ITERATE_ORGANIZATIONS_CLAIM]: z.array(IterateAuthOrganizationClaim).optional(),
});

export type IdTokenClaims = z.infer<typeof IdTokenClaims>;
export type AccessTokenClaims = z.infer<typeof AccessTokenClaims>;
export type UserInfoClaims = z.infer<typeof UserInfoClaims>;

export type AuthUser = {
  id: string;
  email: string;
  name?: string;
  picture?: string;
  givenName?: string;
  familyName?: string;
  emailVerified?: boolean;
  role?: string | null;
  isAdmin?: boolean;
};

export type AuthSession = {
  expiresAt: number;
  scope: string;
  sessionId?: string;
  activeOrganizationId?: string | null;
  organizations: IterateAuthOrganizationClaimType[];
  projects: IterateAuthProjectClaimType[];
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
  userInfo: UserInfoClaims | null,
): AuthenticatedSession {
  const accessTokenOrganizations =
    accessToken[ITERATE_ACCESS_TOKEN_ORGANIZATIONS_CLAIM]?.map((organization) => ({
      ...organization,
      name:
        userInfo?.[ITERATE_ORGANIZATIONS_CLAIM]?.find(
          (userInfoOrganization) => userInfoOrganization.id === organization.id,
        )?.name ??
        organization.name ??
        organization.slug,
    })) ?? null;

  return {
    user: {
      id: idToken.sub,
      email: idToken.email,
      name: idToken.name,
      picture: idToken.picture,
      givenName: idToken.given_name,
      familyName: idToken.family_name,
      emailVerified: idToken.email_verified,
      role: idToken[ITERATE_ROLE_CLAIM] ?? null,
      isAdmin: idToken[ITERATE_IS_ADMIN_CLAIM] ?? false,
    },
    session: {
      expiresAt: accessToken.exp,
      scope: accessToken.scope,
      sessionId: accessToken.sid,
      activeOrganizationId: userInfo?.[ITERATE_ACTIVE_ORGANIZATION_ID_CLAIM] ?? null,
      organizations: accessTokenOrganizations ?? userInfo?.[ITERATE_ORGANIZATIONS_CLAIM] ?? [],
      projects: accessToken[ITERATE_ACCESS_TOKEN_PROJECTS_CLAIM] ?? [],
    },
    tokenClaims: { accessToken, idToken },
  };
}

export type SessionResponse =
  | { authenticated: false }
  | ({ authenticated: true } & AuthenticatedSession);

const OAuthState = z.object({
  nonce: z.string(),
  returnTo: z.string().optional(),
  state: z.string(),
  verifier: z.string(),
});

type OAuthState = z.infer<typeof OAuthState>;

type JWKS = ReturnType<typeof createRemoteJWKSet> | ReturnType<typeof createLocalJWKSet>;

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
  getUserInfo: (accessToken: string) => Promise<UserInfoClaims | null>;
  cookieOpts: () => { httpOnly: true; path: string; sameSite: "Lax"; secure: boolean };
  resource: () => string;
  audiences: () => string[];
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

  function audiences() {
    const resources = Array.isArray(config.resource) ? config.resource : [config.resource];
    const configuredResources = resources.filter((resource): resource is string => !!resource);
    return configuredResources.length > 0 ? configuredResources : [issuerURL.href];
  }

  function resource() {
    return audiences()[0] ?? issuerURL.href;
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

  // The auth server rotates refresh tokens on every use and treats reuse of a
  // rotated token as theft (revoking the whole token family). Concurrent
  // requests carrying the same cookie must therefore share one refresh
  // flight per refresh token instead of racing the token endpoint.
  const refreshSingleFlight = createSingleFlight<TokenSet | null>();

  function doRefresh(tokenSet: TokenSet): Promise<TokenSet | null> {
    const refreshToken = tokenSet.refreshToken;
    if (!refreshToken) return Promise.resolve(null);

    return refreshSingleFlight(refreshToken, async () => {
      const as = await getAuthorizationServer();
      const response = await oauth.refreshTokenGrantRequest(
        as,
        oauthClient,
        clientAuth,
        refreshToken,
        {
          ...httpOptions(),
          additionalParameters: { resource: resource() },
        },
      );
      const result = await oauth.processRefreshTokenResponse(as, oauthClient, response);
      return toTokenSet(result, tokenSet);
    });
  }

  async function getUserInfo(accessToken: string): Promise<UserInfoClaims | null> {
    const as = await getAuthorizationServer();
    if (!as.userinfo_endpoint) {
      return null;
    }

    const response = await fetch(as.userinfo_endpoint, {
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: "application/json",
      },
    });

    if (!response.ok) {
      return null;
    }

    return UserInfoClaims.parse(await response.json());
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
    getUserInfo,
    cookieOpts: () =>
      ({ httpOnly: true, path: "/", sameSite: "Lax", secure: secureCookies }) as const,
    resource,
    audiences,
  };
}

export type AuthenticateResult = {
  session: AuthenticatedSession | null;
  responseHeaders: Headers;
};

export type AuthenticateOptions = {
  /**
   * Fetch fresh userinfo claims from the issuer while authenticating a cookie
   * session. Route and API auth should usually leave this disabled so JWT
   * validation stays local to the worker isolate.
   */
  includeUserInfo?: boolean;
};

export function createAuthMiddleware(config: IterateAuthConfig, infra: OAuthInfra) {
  const prefix = config.cookiePrefix ?? "iterate";
  const SESSION_COOKIE = `${prefix}_session`;
  const issuer = new URL(config.issuer ?? DEFAULT_ISSUER).href;
  const { jwks, doRefresh, getUserInfo, cookieOpts, audiences } = infra;

  function serializeSessionCookie(tokenSet: TokenSet): string {
    const expires = tokenSet.refreshToken
      ? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
      : new Date(tokenSet.accessTokenExpiresAt);
    return serialize(SESSION_COOKIE, JSON.stringify(tokenSet), { ...cookieOpts(), expires });
  }

  return {
    async authenticate({
      headers,
      includeUserInfo = true,
    }: { headers: Headers } & AuthenticateOptions): Promise<AuthenticateResult> {
      const cookieJar = parse(headers.get("Cookie") ?? "");
      if (!cookieJar) return { session: null, responseHeaders: new Headers() };

      let tokenSet: TokenSet;
      try {
        tokenSet = TokenSet.parse(JSON.parse(cookieJar[SESSION_COOKIE]));
      } catch {
        return { session: null, responseHeaders: new Headers() };
      }

      if (!tokenSet.idToken) return { session: null, responseHeaders: new Headers() };

      // WebSocket upgrades can't carry Set-Cookie back to the browser, so a
      // refresh here would rotate the refresh token into a response the
      // client can never store — burning the session. Upgrades authenticate
      // with the current access token only; once it expires they fail until
      // a regular request refreshes the cookie and the client reconnects.
      const isWebSocketUpgrade = headers.get("upgrade")?.toLowerCase() === "websocket";
      const accessTokenExpired = tokenSet.accessTokenExpiresAt <= Date.now();
      const accessTokenExpiresSoon = tokenSet.accessTokenExpiresAt <= Date.now() + REFRESH_SKEW_MS;

      let refreshed = false;
      if (accessTokenExpiresSoon && !isWebSocketUpgrade) {
        try {
          const newTokenSet = await doRefresh(tokenSet);
          if (newTokenSet) {
            tokenSet = newTokenSet;
            refreshed = true;
          } else if (accessTokenExpired) {
            return { session: null, responseHeaders: new Headers() };
          }
        } catch {
          // A failed refresh while the current access token is still valid is
          // not fatal: serve this request with the existing token and let a
          // later request retry the refresh.
          if (accessTokenExpired) {
            return { session: null, responseHeaders: new Headers() };
          }
        }
      } else if (accessTokenExpired) {
        return { session: null, responseHeaders: new Headers() };
      }

      try {
        const { payload: rawAccessToken } = await jwtVerify(tokenSet.accessToken, jwks, {
          issuer,
          audience: audiences(),
        });
        const { payload: rawIdToken } = await jwtVerify(tokenSet.idToken, jwks, {
          issuer,
          audience: config.clientId,
        });

        const accessToken = AccessTokenClaims.parse(rawAccessToken);
        const idToken = IdTokenClaims.parse(rawIdToken);
        const userInfo = includeUserInfo ? await getUserInfo(tokenSet.accessToken) : null;

        const responseHeaders = new Headers();
        if (refreshed) {
          responseHeaders.set("Set-Cookie", serializeSessionCookie(tokenSet));
        }

        return {
          session: buildAuthenticatedSession(accessToken, idToken, userInfo),
          responseHeaders,
        };
      } catch {
        return { session: null, responseHeaders: new Headers() };
      }
    },
    async authenticateBearer({ headers }: { headers: Headers }): Promise<AccessTokenClaims | null> {
      const match = /^bearer\s+(.+)$/i.exec(headers.get("authorization") ?? "");
      const token = match?.[1]?.trim();
      if (!token) return null;

      try {
        const { payload } = await jwtVerify(token, jwks, {
          issuer,
          audience: audiences(),
        });
        return AccessTokenClaims.parse(payload);
      } catch {
        return null;
      }
    },
  };
}

export function createAuthHandler(config: IterateAuthConfig, infra: OAuthInfra) {
  const { issuerURL, jwks, oauthClient, clientAuth } = infra;
  const { getAuthorizationServer, httpOptions, toTokenSet, doRefresh, getUserInfo, cookieOpts } =
    infra;
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

  const authHandlerBasePath = normalizeAuthHandlerBasePath(config.authHandlerBasePath);
  const app = new Hono().basePath(authHandlerBasePath);

  app.get("/login", async (c) => {
    const requestURL = new URL(c.req.url);
    const canonicalLoginURL = localLoopbackCanonicalLoginURL(requestURL, config.redirectURI);
    if (canonicalLoginURL) {
      return c.redirect(canonicalLoginURL.toString());
    }

    const as = await getAuthorizationServer();
    if (!as.authorization_endpoint) throw new Error("No authorization_endpoint in server metadata");

    const returnTo = resolveAllowedReturnTo(requestURL.searchParams.get("return_to"), [
      requestURL.origin,
      ...(config.logoutReturnToOrigins ?? []),
    ]);
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

    setCookie(
      c,
      STATE_COOKIE,
      JSON.stringify({ nonce, returnTo, state, verifier } satisfies OAuthState),
      {
        ...cookieOpts(),
        maxAge: 10 * 60,
      },
    );

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
          additionalParameters: { resource: infra.resource() },
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
    return c.redirect(oauthState.returnTo ?? `${requestURL.origin}/`);
  });

  app.get("/session", async (c) => {
    let tokenSet = getTokenSet(c);
    const forceRefresh = c.req.query("refresh") === "force";
    if (
      tokenSet &&
      tokenSet.refreshToken &&
      (forceRefresh || tokenSet.accessTokenExpiresAt <= Date.now() + REFRESH_SKEW_MS)
    ) {
      const accessTokenExpired = tokenSet.accessTokenExpiresAt <= Date.now();
      try {
        tokenSet = (await doRefresh(tokenSet)) ?? tokenSet;
      } catch {
        if (accessTokenExpired) {
          deleteCookie(c, SESSION_COOKIE, cookieOpts());
          return c.json({ authenticated: false } satisfies SessionResponse, 401);
        }
      }
    }

    if (!tokenSet || !tokenSet.idToken) {
      return c.json({ authenticated: false } satisfies SessionResponse);
    }

    try {
      const { payload: rawAccessToken } = await jwtVerify(tokenSet.accessToken, jwks, {
        issuer: issuerURL.href,
        audience: infra.audiences(),
      });
      const { payload: rawIdToken } = await jwtVerify(tokenSet.idToken, jwks, {
        issuer: issuerURL.href,
        audience: config.clientId,
      });

      const accessToken = AccessTokenClaims.parse(rawAccessToken);
      const idToken = IdTokenClaims.parse(rawIdToken);
      const userInfo = await getUserInfo(tokenSet.accessToken);

      writeCookie(c, tokenSet);
      return c.json({
        authenticated: true,
        ...buildAuthenticatedSession(accessToken, idToken, userInfo),
      } satisfies SessionResponse);
    } catch {
      deleteCookie(c, SESSION_COOKIE, cookieOpts());
      return c.json({ authenticated: false } satisfies SessionResponse, 401);
    }
  });

  // One-URL sign-in for minted/programmatic tokens: validates an access+id
  // token pair against the trusted JWKS and writes the normal session cookie.
  // Used by Playwright/agent-browser/humans via `pnpm auth:mint --browser-url`.
  // No new trust is introduced — only tokens signed by a key in this
  // deployment's JWKS are accepted, the same check every request performs.
  app.get("/session-from-token", async (c) => {
    const requestURL = new URL(c.req.url);
    const accessToken = requestURL.searchParams.get("access_token")?.trim();
    const idToken = requestURL.searchParams.get("id_token")?.trim();
    if (!accessToken || !idToken) {
      return c.text("access_token and id_token query params are required", 400);
    }

    let accessTokenExp: number;
    try {
      const { payload: rawAccessToken } = await jwtVerify(accessToken, jwks, {
        issuer: issuerURL.href,
        audience: infra.audiences(),
      });
      const { payload: rawIdToken } = await jwtVerify(idToken, jwks, {
        issuer: issuerURL.href,
        audience: config.clientId,
      });
      AccessTokenClaims.parse(rawAccessToken);
      IdTokenClaims.parse(rawIdToken);
      accessTokenExp = rawAccessToken.exp ?? Math.floor(Date.now() / 1000) + 60;
    } catch (error) {
      return c.text(`Token validation failed: ${error}`, 401);
    }

    writeCookie(c, {
      accessToken,
      accessTokenExpiresAt: accessTokenExp * 1000,
      idToken,
      tokenType: "bearer",
    });

    const returnTo = resolveAllowedReturnTo(requestURL.searchParams.get("return_to"), [
      requestURL.origin,
      ...(config.logoutReturnToOrigins ?? []),
    ]);
    return c.redirect(returnTo);
  });

  app.get("/logout", async (c) => {
    const tokenSet = getTokenSet(c);
    deleteCookie(c, SESSION_COOKIE, cookieOpts());
    deleteCookie(c, STATE_COOKIE, cookieOpts());

    if (tokenSet?.refreshToken) {
      await revokeRefreshToken(tokenSet.refreshToken);
    }

    const requestURL = new URL(c.req.url);
    const returnTo = resolveAllowedReturnTo(requestURL.searchParams.get("return_to"), [
      requestURL.origin,
      ...(config.logoutReturnToOrigins ?? []),
    ]);
    if (requestURL.searchParams.get("global") === "false") {
      return c.redirect(returnTo);
    }

    const authLogoutUrl = new URL("/logout", issuerURL.origin);
    authLogoutUrl.searchParams.set("return_to", returnTo);
    return c.redirect(authLogoutUrl.toString());
  });

  app.post("/logout", async (c) => {
    const tokenSet = getTokenSet(c);
    deleteCookie(c, SESSION_COOKIE, cookieOpts());
    deleteCookie(c, STATE_COOKIE, cookieOpts());

    if (tokenSet?.refreshToken) {
      await revokeRefreshToken(tokenSet.refreshToken);
    }

    return c.redirect("/");
  });

  async function revokeRefreshToken(refreshToken: string) {
    try {
      const as = await getAuthorizationServer();
      const revokeResponse = await oauth.revocationRequest(
        as,
        oauthClient,
        clientAuth,
        refreshToken,
        httpOptions(),
      );
      await oauth.processRevocationResponse(revokeResponse);
    } catch {
      // Ignore revoke failures during logout.
    }
  }

  return {
    handler(request: Request): Response | Promise<Response> {
      return app.fetch(request);
    },
  };
}

export function resolveAllowedReturnTo(rawReturnTo: string | null, allowedOrigins: string[]) {
  const fallbackOrigin = allowedOrigins[0];
  if (!fallbackOrigin) {
    throw new Error("resolveAllowedReturnTo requires at least one allowed origin");
  }
  if (!rawReturnTo) return `${fallbackOrigin}/`;
  try {
    const parsed = new URL(rawReturnTo, fallbackOrigin);
    return allowedOrigins.includes(parsed.origin) ? parsed.toString() : `${fallbackOrigin}/`;
  } catch {
    return `${fallbackOrigin}/`;
  }
}

export function createIterateAuth(config: IterateAuthConfig) {
  if (!config.clientId || !config.clientSecret || !config.redirectURI) {
    throw new Error(
      "Missing required OAuth client configuration: clientId, clientSecret, and redirectURI are required",
    );
  }

  const issuer = config.issuer ?? DEFAULT_ISSUER;
  const jwks = config.jwks
    ? createLocalJWKSet(config.jwks)
    : createRemoteJWKSet(new URL(`${issuer}/jwks`));
  const infra = createOAuthInfra(config, jwks);

  const routes = createAuthHandler(config, infra);
  const middleware = createAuthMiddleware(config, infra);
  const authHandlerBasePath = normalizeAuthHandlerBasePath(config.authHandlerBasePath);

  return {
    authHandlerBasePath,
    handler: routes.handler,
    handleRequest(request: Request): Response | Promise<Response> | null {
      if (!isAuthHandlerRequest(request, authHandlerBasePath)) {
        return null;
      }
      return routes.handler(request);
    },
    authenticate: middleware.authenticate,
    authenticateBearer: middleware.authenticateBearer,
  };
}

export function isAuthHandlerRequest(
  request: Request,
  authHandlerBasePath = DEFAULT_AUTH_HANDLER_BASE_PATH,
) {
  const pathname = new URL(request.url).pathname;
  const basePath = normalizeAuthHandlerBasePath(authHandlerBasePath);
  return pathname === basePath || pathname.startsWith(`${basePath}/`);
}

function normalizeAuthHandlerBasePath(authHandlerBasePath: string | undefined) {
  const basePath = authHandlerBasePath ?? DEFAULT_AUTH_HANDLER_BASE_PATH;
  const normalized = `/${basePath.replace(/^\/+|\/+$/g, "")}`;
  return normalized === "/" ? DEFAULT_AUTH_HANDLER_BASE_PATH : normalized;
}

function localLoopbackCanonicalLoginURL(requestURL: URL, redirectURI: string) {
  const redirectURL = new URL(redirectURI);
  if (requestURL.origin === redirectURL.origin) return null;
  if (!isLocalLoopbackHostname(requestURL.hostname)) return null;
  if (!isLocalLoopbackHostname(redirectURL.hostname)) return null;

  return new URL(`${requestURL.pathname}${requestURL.search}`, redirectURL.origin);
}

function isLocalLoopbackHostname(hostname: string) {
  const normalized = hostname.toLowerCase();
  return (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "[::1]"
  );
}
