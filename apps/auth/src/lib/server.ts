import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { parse, serialize } from "hono/utils/cookie";
import {
  createLocalJWKSet,
  createRemoteJWKSet,
  jwtVerify,
  type JSONWebKeySet,
  type JWTVerifyGetKey,
} from "jose";
import * as oauth from "oauth4webapi";
import { z } from "zod/v4";
import { expandOAuthResourceAudienceVariants } from "@iterate-com/shared/oauth-resource";
import {
  AccessTokenClaims,
  buildAuthenticatedSession,
  IdTokenClaims,
  identityFromAccessToken,
  identityFromSession,
  TokenSet,
  UserInfoClaims,
  type AuthenticatedIdentity,
  type AuthenticatedSession,
  type SessionResponse,
} from "./session.ts";
import { createSingleFlight } from "./single-flight.ts";

const DEFAULT_ISSUER = "https://auth.iterate.com/api/auth";
const DEFAULT_AUTH_HANDLER_BASE_PATH = "/api/iterate-auth";
const SCOPES = ["openid", "profile", "email", "offline_access"] as const;
const REFRESH_SKEW_MS = 30_000;

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

const OAuthState = z.object({
  nonce: z.string(),
  returnTo: z.string().optional(),
  state: z.string(),
  verifier: z.string(),
});

type OAuthState = z.infer<typeof OAuthState>;

/** Key resolver handed to jose's jwtVerify (local baked set, remote set, or the stale-bake fallback chain built in createIterateAuth). */
type JWKS = JWTVerifyGetKey;

/** Internal dependency boundary used by the owning package's tests. */
export type OAuthInfra = {
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

type VerifyTokenSetResult =
  | {
      ok: true;
      accessToken: AccessTokenClaims;
      idToken: IdTokenClaims;
    }
  | {
      ok: false;
      reason: AuthenticateErrorReason;
      error: unknown;
    };

async function verifyTokenSet(input: {
  tokenSet: TokenSet;
  jwks: JWKS;
  issuer: string;
  audiences: string[];
  clientId: string;
}): Promise<VerifyTokenSetResult> {
  let rawAccessToken: unknown;
  try {
    const { payload } = await jwtVerify(input.tokenSet.accessToken, input.jwks, {
      issuer: input.issuer,
      audience: input.audiences,
    });
    rawAccessToken = payload;
  } catch (error) {
    return { ok: false, reason: "access_token_verify_failed", error };
  }

  let rawIdToken: unknown;
  try {
    const { payload } = await jwtVerify(input.tokenSet.idToken, input.jwks, {
      issuer: input.issuer,
      audience: input.clientId,
    });
    rawIdToken = payload;
  } catch (error) {
    return { ok: false, reason: "id_token_verify_failed", error };
  }

  try {
    return {
      ok: true,
      accessToken: AccessTokenClaims.parse(rawAccessToken),
      idToken: IdTokenClaims.parse(rawIdToken),
    };
  } catch (error) {
    return { ok: false, reason: "session_claims_parse_failed", error };
  }
}

function hasJwtShapedTokens(tokenSet: TokenSet) {
  return tokenSet.accessToken.split(".").length === 3 && tokenSet.idToken.split(".").length === 3;
}

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
    return configuredResources.length > 0
      ? expandOAuthResourceAudienceVariants(configuredResources)
      : [issuerURL.href];
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

type AuthenticateErrorReason =
  | "session_cookie_parse_failed"
  | "session_refresh_failed"
  | "access_token_verify_failed"
  | "id_token_verify_failed"
  | "session_claims_parse_failed";

export type AuthenticateErrorEvent = {
  reason: AuthenticateErrorReason;
  error: unknown;
};

type SessionAuthenticationOptions = {
  /**
   * Fetch fresh userinfo claims from the issuer while authenticating a cookie
   * session. Defaults to false so route and API auth keep JWT validation local
   * to the worker isolate.
   */
  includeUserInfo?: boolean;
  /** Reports failed session work, including a non-fatal refresh before successful verification. */
  onError?: (event: AuthenticateErrorEvent) => void;
  /**
   * Whether this call may rotate the refresh token. Use `"never"` when the
   * surrounding transport cannot return `Set-Cookie` (notably an in-band RPC
   * authentication method). WebSocket upgrades are always treated as
   * `"never"` regardless of this option.
   */
  refresh?: "if-needed" | "never";
};

/** The credential, if any, proven by one relying-party request. */
type Authentication =
  | {
      credential: "session";
      identity: AuthenticatedIdentity;
      session: AuthenticatedSession;
      responseHeaders: Headers;
    }
  | {
      accessToken: AccessTokenClaims;
      credential: "bearer";
      identity: AuthenticatedIdentity;
      responseHeaders: Headers;
    }
  | {
      credential: null;
      responseHeaders: Headers;
    };

type SessionAuthentication = {
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

  function responseHeadersForRefresh(tokenSet: TokenSet, refreshed: boolean): Headers {
    const responseHeaders = new Headers();
    if (refreshed) responseHeaders.set("Set-Cookie", serializeSessionCookie(tokenSet));
    return responseHeaders;
  }

  return {
    async authenticate({
      headers,
      includeUserInfo = false,
      onError,
      refresh = "if-needed",
    }: { headers: Headers } & SessionAuthenticationOptions): Promise<SessionAuthentication> {
      const cookieJar = parse(headers.get("Cookie") ?? "");
      const rawTokenSet = cookieJar?.[SESSION_COOKIE];
      if (!rawTokenSet) return { session: null, responseHeaders: new Headers() };

      let tokenSet: TokenSet;
      try {
        tokenSet = TokenSet.parse(JSON.parse(rawTokenSet));
      } catch (error) {
        onError?.({ reason: "session_cookie_parse_failed", error });
        return { session: null, responseHeaders: new Headers() };
      }

      if (!tokenSet.idToken) return { session: null, responseHeaders: new Headers() };

      // Some transports cannot carry Set-Cookie back to the browser. A refresh
      // there would rotate the token into a response the client cannot store,
      // burning the session. Such requests authenticate with the current
      // access token only; after expiry, a normal HTTP request must refresh it.
      const isWebSocketUpgrade = headers.get("upgrade")?.toLowerCase() === "websocket";
      const mayRefresh = refresh === "if-needed" && !isWebSocketUpgrade;
      const accessTokenExpired = tokenSet.accessTokenExpiresAt <= Date.now();
      const accessTokenExpiresSoon = tokenSet.accessTokenExpiresAt <= Date.now() + REFRESH_SKEW_MS;

      let refreshed = false;
      if (accessTokenExpiresSoon && mayRefresh) {
        try {
          const newTokenSet = await doRefresh(tokenSet);
          if (newTokenSet) {
            tokenSet = newTokenSet;
            refreshed = true;
          } else if (accessTokenExpired) {
            return { session: null, responseHeaders: new Headers() };
          }
        } catch (error) {
          onError?.({ reason: "session_refresh_failed", error });
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

      let verification = await verifyTokenSet({
        tokenSet,
        jwks,
        issuer,
        audiences: audiences(),
        clientId: config.clientId,
      });
      if (
        !verification.ok &&
        tokenSet.refreshToken &&
        !refreshed &&
        mayRefresh &&
        hasJwtShapedTokens(tokenSet)
      ) {
        try {
          const newTokenSet = await doRefresh(tokenSet);
          if (newTokenSet) {
            tokenSet = newTokenSet;
            refreshed = true;
            verification = await verifyTokenSet({
              tokenSet,
              jwks,
              issuer,
              audiences: audiences(),
              clientId: config.clientId,
            });
          }
        } catch (error) {
          onError?.({ reason: "session_refresh_failed", error });
        }
      }

      if (!verification.ok) {
        onError?.({ reason: verification.reason, error: verification.error });
        return { session: null, responseHeaders: responseHeadersForRefresh(tokenSet, refreshed) };
      }

      try {
        const userInfo = includeUserInfo ? await getUserInfo(tokenSet.accessToken) : null;

        return {
          session: buildAuthenticatedSession(
            verification.accessToken,
            verification.idToken,
            userInfo,
          ),
          responseHeaders: responseHeadersForRefresh(tokenSet, refreshed),
        };
      } catch (error) {
        onError?.({ reason: "session_claims_parse_failed", error });
        return { session: null, responseHeaders: responseHeadersForRefresh(tokenSet, refreshed) };
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

  function allowedReturnToOrigins(requestURL: URL) {
    return [...new Set([...(config.logoutReturnToOrigins ?? []), requestURL.origin])];
  }

  app.get("/login", async (c) => {
    const requestURL = new URL(c.req.url);
    const canonicalLoginURL = localLoopbackCanonicalLoginURL(requestURL, config.redirectURI);
    if (canonicalLoginURL) {
      return c.redirect(canonicalLoginURL.toString());
    }

    const as = await getAuthorizationServer();
    if (!as.authorization_endpoint) throw new Error("No authorization_endpoint in server metadata");

    const returnTo = resolveAllowedReturnTo(
      requestURL.searchParams.get("return_to"),
      allowedReturnToOrigins(requestURL),
    );
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
    const loginHint = requestURL.searchParams.get("login_hint");
    if (loginHint === "email" || loginHint === "google") {
      url.searchParams.set("login_hint", loginHint);
    }

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
    // Structured per-step timing for cold-deploy diagnosis (see
    // tasks/os-cold-create-latency.md): one greppable line per remote hop.
    const timeStep = async <T>(step: string, fn: () => Promise<T>): Promise<T> => {
      const start = Date.now();
      try {
        return await fn();
      } finally {
        console.log("[callback-timing]", JSON.stringify({ step, ms: Date.now() - start }));
      }
    };
    const as = await timeStep("discovery", () => getAuthorizationServer());
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
      const response = await timeStep("token-exchange", () =>
        oauth.authorizationCodeGrantRequest(
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
        ),
      );
      tokenResponse = await timeStep("token-exchange-process", () =>
        oauth.processAuthorizationCodeResponse(as, oauthClient, response, {
          expectedNonce: oauthState.nonce,
        }),
      );
    } catch (error) {
      console.error("OAuth callback error:", error);
      let message = error instanceof Error ? error.message : String(error);
      // oauth4webapi collapses any token-endpoint OAuth error into one generic
      // message; without the server's error code ("invalid_client" vs
      // "invalid_grant") a failed exchange is undiagnosable from the page the
      // user (or a Playwright screenshot) sees.
      if (error instanceof oauth.ResponseBodyError) {
        message += ` [${error.error}${error.error_description ? `: ${error.error_description}` : ""}] (token endpoint HTTP ${error.status})`;
      }
      return c.text(`OAuth callback exchange failed: ${message}`, 502);
    }

    writeCookie(c, toTokenSet(tokenResponse));
    deleteCookie(c, STATE_COOKIE, cookieOpts());
    return c.redirect(oauthState.returnTo ?? `${requestURL.origin}/`);
  });

  app.get("/session", async (c) => {
    let tokenSet = getTokenSet(c);
    const forceRefresh = c.req.query("refresh") === "force";
    let refreshed = false;
    let staleRefreshReason: string | null = null;
    if (
      tokenSet &&
      tokenSet.refreshToken &&
      (forceRefresh || tokenSet.accessTokenExpiresAt <= Date.now() + REFRESH_SKEW_MS)
    ) {
      const accessTokenExpired = tokenSet.accessTokenExpiresAt <= Date.now();
      try {
        const refreshedTokenSet = await doRefresh(tokenSet);
        if (refreshedTokenSet) {
          tokenSet = refreshedTokenSet;
          refreshed = true;
        }
      } catch (error) {
        if (accessTokenExpired) {
          deleteCookie(c, SESSION_COOKIE, cookieOpts());
          return c.json({ authenticated: false } satisfies SessionResponse, 401);
        }
        staleRefreshReason = error instanceof Error ? error.message : String(error);
      }
    } else if (tokenSet && forceRefresh) {
      // A session cookie without a refresh token (minted sessions —
      // scripts/auth/mint-session.ts) can never pick up new claims: whatever
      // orgs/projects it was minted with is all it will ever carry.
      staleRefreshReason = "session has no refresh token; claims are frozen at mint time";
    }

    if (!tokenSet || !tokenSet.idToken) {
      return c.json({ authenticated: false } satisfies SessionResponse);
    }

    let verification = await verifyTokenSet({
      tokenSet,
      jwks,
      issuer: issuerURL.href,
      audiences: infra.audiences(),
      clientId: config.clientId,
    });
    if (!verification.ok && tokenSet.refreshToken && !refreshed && hasJwtShapedTokens(tokenSet)) {
      try {
        const refreshedTokenSet = await doRefresh(tokenSet);
        if (refreshedTokenSet) {
          tokenSet = refreshedTokenSet;
          refreshed = true;
          verification = await verifyTokenSet({
            tokenSet,
            jwks,
            issuer: issuerURL.href,
            audiences: infra.audiences(),
            clientId: config.clientId,
          });
        }
      } catch {
        // Fall through to the unauthenticated response below.
      }
    }

    if (!verification.ok) {
      deleteCookie(c, SESSION_COOKIE, cookieOpts());
      return c.json({ authenticated: false } satisfies SessionResponse, 401);
    }

    let userInfo: UserInfoClaims | null;
    try {
      userInfo = await getUserInfo(tokenSet.accessToken);
    } catch {
      deleteCookie(c, SESSION_COOKIE, cookieOpts());
      return c.json({ authenticated: false } satisfies SessionResponse, 401);
    }

    if (staleRefreshReason !== null && !refreshed) {
      // A refresh that produced no fresh tokens is invisible in the 200 body:
      // the caller asked for current claims and got the cookie's old ones. Say
      // so — the header lets fetchSession warn in the browser console, the log
      // makes frozen-claims incidents greppable (a silent variant of this
      // presented as "created project missing from the project list",
      // 2026-07-17 prd).
      console.warn(
        "[iterate-auth] session refresh produced no fresh tokens; serving existing claims",
        {
          forced: forceRefresh,
          reason: staleRefreshReason,
        },
      );
      c.header("x-iterate-auth-stale-refresh", "1");
    }
    writeCookie(c, tokenSet);
    return c.json({
      authenticated: true,
      ...buildAuthenticatedSession(verification.accessToken, verification.idToken, userInfo),
    } satisfies SessionResponse);
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

    const returnTo = resolveAllowedReturnTo(
      requestURL.searchParams.get("return_to"),
      allowedReturnToOrigins(requestURL),
    );
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
    const returnTo = resolveAllowedReturnTo(
      requestURL.searchParams.get("return_to"),
      allowedReturnToOrigins(requestURL),
    );
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

  return (request: Request): Response | Promise<Response> => app.fetch(request);
}

function resolveAllowedReturnTo(rawReturnTo: string | null, allowedOrigins: string[]) {
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

/** Iterate auth composed as an ordinary partial fetch plus explicit credential checks. */
interface IterateAuth {
  readonly authHandlerBasePath: string;
  /** Return a response for an auth-owned route, or `null` without consuming the request. */
  fetch(request: Request): Promise<Response | null>;
  /** Authenticate a browser session first, then a bearer token. */
  authenticate(
    options: { headers: Headers } & SessionAuthenticationOptions,
  ): Promise<Authentication>;
  /** Authenticate only the session cookie. */
  authenticateSession(
    options: { headers: Headers } & SessionAuthenticationOptions,
  ): Promise<SessionAuthentication>;
  /** Authenticate only an OAuth bearer token. */
  authenticateBearer(options: { headers: Headers }): Promise<AccessTokenClaims | null>;
}

export function createIterateAuth(config: IterateAuthConfig): IterateAuth {
  if (!config.clientId || !config.clientSecret || !config.redirectURI) {
    throw new Error(
      "Missing required OAuth client configuration: clientId, clientSecret, and redirectURI are required",
    );
  }

  const issuer = config.issuer ?? DEFAULT_ISSUER;
  // Prefer the baked JWKS (no network roundtrip, and it is the only set that
  // carries the identity-forge key), but fall back to the issuer's live JWKS
  // when a token's kid is unknown: the baked set goes stale if the issuer's
  // key set changes after this worker was deployed (observed on preview-2 on
  // 2026-07-04 — see docs/preview-e2e-flake-hunt.md), and without the
  // fallback every verification fails until the next redeploy.
  const jwks: JWTVerifyGetKey = (() => {
    if (!config.jwks) return createRemoteJWKSet(new URL(`${issuer}/jwks`));
    const local = createLocalJWKSet(config.jwks);
    let remote: JWTVerifyGetKey | undefined;
    return async (protectedHeader, token) => {
      try {
        return await local(protectedHeader, token);
      } catch (error) {
        if ((error as { code?: string }).code !== "ERR_JWKS_NO_MATCHING_KEY") throw error;
        remote ??= createRemoteJWKSet(new URL(`${issuer}/jwks`));
        return await remote(protectedHeader, token);
      }
    };
  })();
  const infra = createOAuthInfra(config, jwks);

  const fetchAuthRoute = createAuthHandler(config, infra);
  const middleware = createAuthMiddleware(config, infra);
  const authHandlerBasePath = normalizeAuthHandlerBasePath(config.authHandlerBasePath);

  return {
    authHandlerBasePath,
    async fetch(request: Request): Promise<Response | null> {
      if (!isAuthHandlerRequest(request, authHandlerBasePath)) {
        return null;
      }
      return fetchAuthRoute(request);
    },
    async authenticate(options): Promise<Authentication> {
      const session = await middleware.authenticate(options);
      if (session.session) {
        return {
          credential: "session",
          identity: identityFromSession(session.session),
          session: session.session,
          responseHeaders: session.responseHeaders,
        };
      }

      const accessToken = await middleware.authenticateBearer({ headers: options.headers });
      if (accessToken) {
        return {
          accessToken,
          credential: "bearer",
          identity: identityFromAccessToken(accessToken),
          responseHeaders: session.responseHeaders,
        };
      }

      return { credential: null, responseHeaders: session.responseHeaders };
    },
    authenticateSession: middleware.authenticate,
    authenticateBearer: middleware.authenticateBearer,
  };
}

/** Preserve headers emitted while authenticating when returning the app response. */
export function withAuthenticationResponseHeaders(
  response: Response,
  authenticationHeaders: Headers,
): Response {
  if ([...authenticationHeaders].length === 0) return response;

  // A 101/WebSocket response cannot be reconstructed. Authentication never
  // refreshes on an upgrade, so that path emits no headers and returns above.
  const merged = new Response(response.body, response);
  for (const [name, value] of authenticationHeaders) {
    if (name.toLowerCase() !== "set-cookie") merged.headers.append(name, value);
  }
  for (const cookie of authenticationHeaders.getSetCookie()) {
    merged.headers.append("set-cookie", cookie);
  }
  return merged;
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
