import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { parse, serialize } from "hono/utils/cookie";
import { createRemoteJWKSet, jwtVerify } from "jose";
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

export type IterateAuthConfig = {
  issuer?: string;
  clientId: string;
  clientSecret: string;
  redirectURI: string;
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
        )?.name ?? organization.slug,
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

  function cookieOpts() {
    return { httpOnly: true, path: "/", sameSite: "Lax", secure: secureCookies } as const;
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
        additionalParameters: { resource: resource() },
      },
    );
    const result = await oauth.processRefreshTokenResponse(as, oauthClient, response);
    return toTokenSet(result, tokenSet);
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
    cookieOpts,
    resource,
    audiences,
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
  const { jwks, doRefresh, getUserInfo, cookieOpts, audiences } = infra;

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
          audience: audiences(),
        });
        const { payload: rawIdToken } = await jwtVerify(tokenSet.idToken, jwks, {
          issuer,
          audience: config.clientId,
        });

        const accessToken = AccessTokenClaims.parse(rawAccessToken);
        const idToken = IdTokenClaims.parse(rawIdToken);
        const userInfo = await getUserInfo(tokenSet.accessToken);

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
    const as = await getAuthorizationServer();
    if (!as.authorization_endpoint) throw new Error("No authorization_endpoint in server metadata");

    const requestURL = new URL(c.req.url);
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
  const jwks = createRemoteJWKSet(new URL(`${issuer}/jwks`));
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
