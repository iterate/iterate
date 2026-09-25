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
 * Access tokens carry their client's revocation epoch, like the Google fake's.
 */
import { accountPicker, discoveryDocument, jwks, signIdToken, tokenRequestClient } from "./oidc.ts";
import { nowSeconds, pkceS256, seal, unseal } from "./seal.ts";
import { accessTokenEpochFor, fakeUserIdOf, type IntegrationFakeDeps } from "./state.ts";

interface CloudflareCodePayload {
  t: "cloudflare-code";
  jti: string;
  clientId: string;
  redirectUri: string;
  email: string;
  scope: string;
  codeChallenge: string;
  nonce: string;
  exp: number;
}

interface CloudflareAccessTokenPayload {
  t: "cloudflare-access";
  email: string;
  clientId: string;
  epoch: number;
  exp: number;
}

interface CloudflareRefreshTokenPayload {
  t: "cloudflare-refresh";
  email: string;
  clientId: string;
  scope: string;
}

const oauthError = (error: string, status = 400) => Response.json({ error }, { status });

/** Cloudflare's paths on this origin, or null when the request is not one of them. */
export async function handleCloudflareRequest(
  request: Request,
  deps: IntegrationFakeDeps,
): Promise<Response | null> {
  const url = new URL(request.url);
  const key = `${request.method} ${url.pathname}`;
  const issuer = `${url.origin}/cloudflare`;
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
    if (!(await deps.state.getState()).clients[query.client_id || ""])
      return oauthError("invalid_client");
    if (!URL.canParse(query.redirect_uri || "")) return oauthError("invalid_request");
    // Cloudflare's own login page, when the request names no account
    if (!query.email && !query.login_hint) return accountPicker(url, ["email"]);
    const code: CloudflareCodePayload = {
      t: "cloudflare-code",
      jti: crypto.randomUUID(),
      clientId: query.client_id!,
      redirectUri: query.redirect_uri!,
      email:
        query.email || query.login_hint || `user-${crypto.randomUUID().slice(0, 8)}@petshop.test`,
      scope: query.scope || "openid user-details.read",
      codeChallenge: query.code_challenge || "",
      nonce: query.nonce || "",
      exp: nowSeconds() + 120,
    };
    const target = new URL(code.redirectUri);
    target.searchParams.set("code", await seal(code, deps.sealKey));
    target.searchParams.set("state", query.state || "");
    return Response.redirect(target.toString(), 302);
  }
  if (key === "POST /cloudflare/oauth2/token") {
    const form = Object.fromEntries(new URLSearchParams(await request.text()));
    const { clientId, clientSecret } = tokenRequestClient(request, form);
    const state = await deps.state.getState();
    const client = state.clients[clientId];
    if (!client || client.public || client.clientSecret !== clientSecret)
      return oauthError("invalid_client", 401);
    let grant: { email: string; scope: string; nonce?: string };
    if (form.grant_type === "authorization_code") {
      const code = await unseal<CloudflareCodePayload>(form.code || "", deps.sealKey);
      if (code?.t !== "cloudflare-code" || code.clientId !== clientId || code.exp <= nowSeconds())
        return oauthError("invalid_grant");
      if (form.redirect_uri !== code.redirectUri) return oauthError("invalid_grant");
      if (code.codeChallenge && (await pkceS256(form.code_verifier || "")) !== code.codeChallenge)
        return oauthError("invalid_grant");
      if (!(await deps.state.consumeAuthorizationCode(code.jti)))
        return oauthError("invalid_grant");
      grant = code;
    } else if (form.grant_type === "refresh_token") {
      const refresh = await unseal<CloudflareRefreshTokenPayload>(
        form.refresh_token || "",
        deps.sealKey,
      );
      if (refresh?.t !== "cloudflare-refresh" || refresh.clientId !== clientId)
        return oauthError("invalid_grant");
      grant = refresh;
    } else return oauthError("unsupported_grant_type");
    const scopes = grant.scope.split(" ");
    const access: CloudflareAccessTokenPayload = {
      t: "cloudflare-access",
      email: grant.email,
      clientId,
      epoch: accessTokenEpochFor(state, clientId),
      exp: nowSeconds() + client.accessTokenTtlSeconds,
    };
    const refresh: CloudflareRefreshTokenPayload = {
      t: "cloudflare-refresh",
      email: grant.email,
      clientId,
      scope: grant.scope,
    };
    return Response.json({
      access_token: await seal(access, deps.sealKey),
      expires_in: client.accessTokenTtlSeconds,
      scope: grant.scope,
      token_type: "bearer",
      ...(scopes.includes("offline_access") && {
        refresh_token: await seal(refresh, deps.sealKey),
      }),
      ...(scopes.includes("openid") && {
        id_token: await signIdToken(deps, {
          issuer,
          clientId,
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
    const token = await unseal<CloudflareAccessTokenPayload>(bearer || "", deps.sealKey);
    if (
      token?.t !== "cloudflare-access" ||
      token.exp <= nowSeconds() ||
      token.epoch !== accessTokenEpochFor(await deps.state.getState(), token.clientId)
    )
      return Response.json(
        { success: false, errors: [{ code: 10000, message: "Authentication error" }] },
        { status: 401 },
      );
    return Response.json({
      success: true,
      result: { id: String(fakeUserIdOf(token.email)), email: token.email },
    });
  }
  return null;
}
