/**
 * A Cloudflare-shaped fake: its OAuth server (dash.cloudflare.com's, an
 * OpenID Connect provider) under `/cloudflare` on the pet shop's origin, so it
 * shares the origin with Google's fake, and the one API path sign-in and
 * connect read at the origin itself, as at api.cloudflare.com:
 *
 *   GET  /cloudflare/.well-known/openid-configuration   the issuer is `<origin>/cloudflare`
 *   GET  /cloudflare/.well-known/jwks.json              the JWKS (oidc.ts)
 *   GET  /cloudflare/oauth2/auth     consent at once: a code for `&email=<e>` (else `login_hint`);
 *                                    with neither, its login page (the account picker, oidc.ts)
 *   POST /cloudflare/oauth2/token    authorization_code (PKCE) | refresh_token; the client by
 *                                    HTTP Basic or the form. A refresh token only for
 *                                    `offline_access`, an ID token for `openid`
 *   GET  /client/v4/user             `{ success, result: { id, email } }` for the access token
 *
 * The OAuth steps are the fakes' one authorization server (authorization-server.ts).
 */
import { fakeAuthorizationServer, redirectTo, tokenClient } from "./authorization-server.ts";
import { accountPicker, discoveryDocument, jwks, signIdToken } from "./oidc.ts";
import { fakeUserIdOf, type ShopDeps } from "./state.ts";

interface CloudflareGrant {
  email: string;
  scope: string;
  nonce?: string;
}

const oauthError = (error: string, status = 400) => Response.json({ error }, { status });

/** Cloudflare's paths on this origin, or null when the request is not one of them. */
export async function handleCloudflareRequest(
  request: Request,
  deps: ShopDeps,
): Promise<Response | null> {
  const url = new URL(request.url);
  const key = `${request.method} ${url.pathname}`;
  const issuer = `${url.origin}/cloudflare`;
  const cloudflare = fakeAuthorizationServer<CloudflareGrant>(deps, "cloudflare");
  if (key === "GET /cloudflare/.well-known/openid-configuration")
    return Response.json(
      discoveryDocument(issuer, {
        authorization: "/oauth2/auth",
        token: "/oauth2/token",
        jwks: "/.well-known/jwks.json",
      }),
    );
  if (key === "GET /cloudflare/.well-known/jwks.json") return Response.json(await jwks(deps));
  if (key === "GET /cloudflare/oauth2/auth") {
    const query = Object.fromEntries(url.searchParams);
    const refusal = await cloudflare.authorizeRefusal(
      query.client_id || "",
      query.redirect_uri || "",
    );
    if (refusal) return refusal;
    const email = query.email || query.login_hint;
    // Cloudflare's own login page, when the request names no account
    if (!email) return accountPicker(url, ["email"]);
    const code = await cloudflare.code({
      clientId: query.client_id!,
      redirectUri: query.redirect_uri!,
      codeChallenge: query.code_challenge,
      grant: {
        email,
        scope: query.scope || "openid user-details.read",
        nonce: query.nonce,
      },
    });
    return redirectTo(query.redirect_uri!, { code, state: query.state });
  }
  if (key === "POST /cloudflare/oauth2/token") {
    const form = Object.fromEntries(new URLSearchParams(await request.text()));
    const client = await tokenClient(deps, request, form);
    if (!client || client.client.public) return oauthError("invalid_client", 401);
    let grant: CloudflareGrant;
    if (form.grant_type === "authorization_code") {
      const redeemed = await cloudflare.redeemCode(form.code || "", {
        ...client,
        redirectUri: form.redirect_uri,
        codeVerifier: form.code_verifier,
      });
      if ("refused" in redeemed) return oauthError("invalid_grant");
      grant = redeemed.grant;
    } else if (form.grant_type === "refresh_token") {
      const refresh = await cloudflare.openRefreshToken(form.refresh_token || "", client.clientId);
      if (!refresh) return oauthError("invalid_grant");
      grant = { email: refresh.grant.email, scope: refresh.grant.scope };
    } else return oauthError("unsupported_grant_type");
    const scopes = grant.scope.split(" ");
    const ttlSeconds = client.client.accessTokenTtlSeconds;
    return Response.json({
      access_token: await cloudflare.accessToken(client.clientId, grant, ttlSeconds),
      expires_in: ttlSeconds,
      scope: grant.scope,
      token_type: "bearer",
      ...(scopes.includes("offline_access") && {
        refresh_token: await cloudflare.refreshToken(client.clientId, grant),
      }),
      ...(scopes.includes("openid") && {
        id_token: await signIdToken(deps, {
          issuer,
          clientId: client.clientId,
          claims: {
            sub: String(fakeUserIdOf(grant.email)),
            email: grant.email,
            email_verified: true,
            nonce: grant.nonce || undefined,
          },
        }),
      }),
    });
  }
  if (key === "GET /client/v4/user") {
    const bearer = /^Bearer\s+(\S+)$/i.exec(request.headers.get("authorization") ?? "")?.[1];
    const access = await cloudflare.openAccessToken(bearer || "");
    if (!access)
      return Response.json(
        { success: false, errors: [{ code: 10000, message: "Authentication error" }] },
        { status: 401 },
      );
    const { email } = access.grant;
    return Response.json({ success: true, result: { id: String(fakeUserIdOf(email)), email } });
  }
  return null;
}
