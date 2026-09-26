/**
 * The pet shop's own OAuth 2.0 provider, in front of its pets API — the fakes' one authorization
 * server (authorization-server.ts) at the shop's own paths:
 *
 *   GET  /.well-known/oauth-authorization-server   RFC 8414 metadata
 *   POST /oauth/register     RFC 7591 registration → a client pinned to its redirect_uris;
 *                            token_endpoint_auth_method "none" mints a public client (PKCE, no secret)
 *   GET  /oauth/authorize    ?client_id&redirect_uri&state[&code_challenge][&user=<name>]: consent at
 *                            once, a code for `user` (default "Demo User")
 *   POST /oauth/token        authorization_code | refresh_token; each refresh answers a new refresh
 *                            token. Scheduled failures (`/__backdoor/fail-token-endpoint`) answer 500
 *   POST /api/legacy-login   {email, password: "correct-horse"} → {accessToken, expiresInSeconds}:
 *                            no refresh token, logging in again is the refresh
 *
 * Its access tokens (and the Tesco-shaped login's, tesco-login.ts) are the pets API's bearer.
 */
import { z } from "zod";
import { fakeAuthorizationServer, redirectTo, tokenClient } from "./authorization-server.ts";
import { nowSeconds } from "./seal.ts";
import { DEFAULT_ACCESS_TTL_SECONDS, type ShopDeps } from "./state.ts";

/** The fixture password of the shop's logins (any email or username works). */
export const LOGIN_PASSWORD = "correct-horse";

/** What the shop knows of whoever holds its tokens: the account's name. */
export interface PetshopGrant {
  sub: string;
}

export const petshopOauth = (deps: ShopDeps) =>
  fakeAuthorizationServer<PetshopGrant>(deps, "petshop");

const oauthError = (error: string, error_description?: string, status = 400) =>
  Response.json({ error, error_description }, { status });

const Registration = z.object({
  redirect_uris: z.array(z.url()).min(1),
  token_endpoint_auth_method: z.string().optional(),
});

const LegacyLogin = z.object({ email: z.string().min(1), password: z.literal(LOGIN_PASSWORD) });

/** The provider's paths, or null when the request is not one of them. */
export async function handleOauthProviderRequest(
  request: Request,
  deps: ShopDeps,
): Promise<Response | null> {
  const url = new URL(request.url);
  const key = `${request.method} ${url.pathname}`;
  const petshop = petshopOauth(deps);
  if (key === "GET /.well-known/oauth-authorization-server")
    return Response.json({
      issuer: url.origin,
      authorization_endpoint: `${url.origin}/oauth/authorize`,
      token_endpoint: `${url.origin}/oauth/token`,
      registration_endpoint: `${url.origin}/oauth/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none", "client_secret_basic", "client_secret_post"],
      scopes_supported: ["pets:read", "pets:write"],
    });
  if (key === "POST /oauth/register") {
    const registration = Registration.safeParse(await request.json().catch(() => null));
    if (!registration.success)
      return oauthError("invalid_redirect_uri", "redirect_uris must be absolute URLs");
    const { redirect_uris: redirectUris, token_endpoint_auth_method } = registration.data;
    const isPublic = token_endpoint_auth_method === "none";
    const { clientId, clientSecret } = await deps.state.createClient({
      redirectUris,
      ...(isPublic && { public: true }),
    });
    return Response.json(
      {
        client_id: clientId,
        client_id_issued_at: nowSeconds(),
        // 0 = never expires (RFC 7591 §3.2.1)
        ...(!isPublic && { client_secret: clientSecret, client_secret_expires_at: 0 }),
        redirect_uris: redirectUris,
        token_endpoint_auth_method: isPublic ? "none" : "client_secret_basic",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      },
      { status: 201 },
    );
  }
  if (key === "GET /oauth/authorize") {
    const query = Object.fromEntries(url.searchParams);
    const refusal = await petshop.authorizeRefusal(query.client_id || "", query.redirect_uri || "");
    if (refusal) return refusal;
    const code = await petshop.code({
      clientId: query.client_id!,
      redirectUri: query.redirect_uri!,
      codeChallenge: query.code_challenge,
      grant: { sub: query.user?.slice(0, 64) || "Demo User" },
    });
    return redirectTo(query.redirect_uri!, { code, state: query.state });
  }
  if (key === "POST /oauth/token") {
    const form = Object.fromEntries(new URLSearchParams(await request.text()));
    const client = await tokenClient(deps, request, form);
    if (!client)
      return Response.json(
        { error: "invalid_client" },
        { status: 401, headers: { "www-authenticate": 'Basic realm="dummy-petshop"' } },
      );
    if (await deps.state.consumeTokenEndpointFailure(client.clientId))
      return oauthError(
        "temporarily_unavailable",
        "scheduled by POST /__backdoor/fail-token-endpoint",
        500,
      );
    let grant: PetshopGrant;
    if (form.grant_type === "authorization_code") {
      const redeemed = await petshop.redeemCode(form.code || "", {
        ...client,
        redirectUri: form.redirect_uri,
        codeVerifier: form.code_verifier,
      });
      if ("refused" in redeemed) return oauthError("invalid_grant", redeemed.refused);
      grant = redeemed.grant;
    } else if (form.grant_type === "refresh_token") {
      const refresh = await petshop.openRefreshToken(form.refresh_token || "", client.clientId);
      if (!refresh) return oauthError("invalid_grant", "refresh token unknown or revoked");
      grant = refresh.grant;
    } else return oauthError("unsupported_grant_type");
    const ttlSeconds = client.client.accessTokenTtlSeconds;
    return Response.json({
      access_token: await petshop.accessToken(client.clientId, grant, ttlSeconds),
      token_type: "bearer",
      expires_in: ttlSeconds,
      refresh_token: await petshop.refreshToken(client.clientId, grant),
    });
  }
  if (key === "POST /api/legacy-login") {
    const login = LegacyLogin.safeParse(await request.json().catch(() => null));
    if (!login.success) return Response.json({ error: "invalid_credentials" }, { status: 401 });
    return Response.json({
      accessToken: await petshop.accessToken(
        "legacy-login",
        { sub: login.data.email },
        DEFAULT_ACCESS_TTL_SECONDS,
      ),
      expiresInSeconds: DEFAULT_ACCESS_TTL_SECONDS,
    });
  }
  return null;
}
