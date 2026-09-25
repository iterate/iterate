/**
 * A Google-shaped fake, served on the pet shop's origin at Google's own paths,
 * so an integration pointed at this origin speaks to it exactly as to
 * accounts.google.com, oauth2.googleapis.com, www.googleapis.com and
 * gmail.googleapis.com at once:
 *
 *   GET  /.well-known/openid-configuration   the issuer is this origin (OpenID Connect sign-in)
 *   GET  /oauth2/v3/certs              the JWKS its ID tokens verify against (oidc.ts)
 *   GET  /o/oauth2/v2/auth             consent at once: redirects with a code for the account
 *                                      `&email=<e>` (else `login_hint`), minted when absent; with
 *                                      `prompt=select_account` and neither, the account picker
 *                                      (oidc.ts) asks for the address first
 *   POST /token                        authorization_code (PKCE when the code carried a
 *                                      challenge) | refresh_token; the client by HTTP Basic or
 *                                      the form. Like Google, a refresh token only for a consent
 *                                      prompt (`prompt=consent`), and an RS256 ID token echoing
 *                                      the nonce when `openid` was asked for
 *   GET  /oauth2/v2/userinfo           whose access token this is; the account's id is
 *                                      `fakeUserIdOf(email)`, like Google's numeric `sub`
 *   POST /revoke?token=                a refresh token stops refreshing
 *   GET  /gmail/v1/users/me/profile    the account's Gmail profile
 *
 * Access tokens carry their client's revocation epoch, so the shop's
 * `/__backdoor/expire-tokens { clientId }` forces a 401 and the caller's
 * refresh. Codes and tokens are sealed blobs (seal.ts).
 */
import { accountPicker, discoveryDocument, jwks, signIdToken, tokenRequestClient } from "./oidc.ts";
import { nowSeconds, pkceS256, seal, unseal } from "./seal.ts";
import { accessTokenEpochFor, fakeUserIdOf, type IntegrationFakeDeps } from "./state.ts";

interface GoogleCodePayload {
  t: "google-code";
  jti: string;
  clientId: string;
  redirectUri: string;
  email: string;
  scope: string;
  codeChallenge: string;
  /** The OpenID nonce to echo in the ID token. */
  nonce: string;
  /** The consent prompt was shown: only then does a refresh token come back. */
  consent: boolean;
  exp: number;
}

interface GoogleAccessTokenPayload {
  t: "google-access";
  email: string;
  clientId: string;
  epoch: number;
  exp: number;
}

interface GoogleRefreshTokenPayload {
  t: "google-refresh";
  jti: string;
  email: string;
  clientId: string;
  scope: string;
}

const googleError = (error: string, status = 400) => Response.json({ error }, { status });

/** Google's paths on this origin, or null when the request is not one of them. */
export async function handleGoogleRequest(
  request: Request,
  deps: IntegrationFakeDeps,
): Promise<Response | null> {
  const url = new URL(request.url);
  const key = `${request.method} ${url.pathname}`;
  if (key === "GET /.well-known/openid-configuration")
    return Response.json(
      discoveryDocument(url.origin, {
        authorization: "/o/oauth2/v2/auth",
        token: "/token",
        jwks: "/oauth2/v3/certs",
        userinfo: "/oauth2/v2/userinfo",
      }),
    );
  if (key === "GET /oauth2/v3/certs") return Response.json(await jwks(deps));
  if (key === "GET /o/oauth2/v2/auth") {
    const query = Object.fromEntries(url.searchParams);
    if (!(await deps.state.getState()).clients[query.client_id || ""])
      return googleError("invalid_client");
    if (!URL.canParse(query.redirect_uri || "")) return googleError("redirect_uri_mismatch");
    const prompts = (query.prompt || "").split(" ");
    if (prompts.includes("select_account") && !query.email && !query.login_hint)
      return accountPicker(url, ["email"]);
    const code: GoogleCodePayload = {
      t: "google-code",
      jti: crypto.randomUUID(),
      clientId: query.client_id!,
      redirectUri: query.redirect_uri!,
      email:
        query.email || query.login_hint || `user-${crypto.randomUUID().slice(0, 8)}@petshop.test`,
      scope: query.scope || "openid email profile",
      codeChallenge: query.code_challenge || "",
      nonce: query.nonce || "",
      // `prompt` is a space-separated list (`select_account consent`)
      consent: prompts.includes("consent"),
      exp: nowSeconds() + 120,
    };
    const target = new URL(code.redirectUri);
    target.searchParams.set("code", await seal(code, deps.sealKey));
    target.searchParams.set("state", query.state || "");
    return Response.redirect(target.toString(), 302);
  }
  if (key === "POST /token") {
    const form = Object.fromEntries(new URLSearchParams(await request.text()));
    const { clientId, clientSecret } = tokenRequestClient(request, form);
    const state = await deps.state.getState();
    const client = state.clients[clientId];
    if (!client || client.public || client.clientSecret !== clientSecret)
      return googleError("invalid_client", 401);
    let grant: {
      jti: string;
      email: string;
      scope: string;
      issueRefreshToken: boolean;
      nonce?: string;
    };
    if (form.grant_type === "authorization_code") {
      const code = await unseal<GoogleCodePayload>(form.code || "", deps.sealKey);
      if (code?.t !== "google-code" || code.clientId !== clientId || code.exp <= nowSeconds())
        return googleError("invalid_grant");
      if (form.redirect_uri !== code.redirectUri) return googleError("redirect_uri_mismatch");
      if (code.codeChallenge && (await pkceS256(form.code_verifier || "")) !== code.codeChallenge)
        return googleError("invalid_grant");
      if (!(await deps.state.consumeAuthorizationCode(code.jti)))
        return googleError("invalid_grant");
      grant = {
        jti: crypto.randomUUID(),
        email: code.email,
        scope: code.scope,
        issueRefreshToken: code.consent,
        nonce: code.nonce,
      };
    } else if (form.grant_type === "refresh_token") {
      const refresh = await unseal<GoogleRefreshTokenPayload>(
        form.refresh_token || "",
        deps.sealKey,
      );
      if (
        refresh?.t !== "google-refresh" ||
        refresh.clientId !== clientId ||
        state.revokedRefreshTokenIds.includes(refresh.jti)
      )
        return googleError("invalid_grant");
      grant = { ...refresh, issueRefreshToken: false };
    } else return googleError("unsupported_grant_type");
    const access: GoogleAccessTokenPayload = {
      t: "google-access",
      email: grant.email,
      clientId,
      epoch: accessTokenEpochFor(state, clientId),
      exp: nowSeconds() + client.accessTokenTtlSeconds,
    };
    const refresh: GoogleRefreshTokenPayload = {
      t: "google-refresh",
      jti: grant.jti,
      email: grant.email,
      clientId,
      scope: grant.scope,
    };
    const openid = grant.scope.split(" ").includes("openid");
    return Response.json({
      access_token: await seal(access, deps.sealKey),
      expires_in: client.accessTokenTtlSeconds,
      scope: grant.scope,
      token_type: "Bearer",
      ...(grant.issueRefreshToken && { refresh_token: await seal(refresh, deps.sealKey) }),
      ...(openid && {
        id_token: await signIdToken(deps, {
          issuer: url.origin,
          clientId,
          claims: {
            sub: String(fakeUserIdOf(grant.email)),
            email: grant.email,
            email_verified: true,
            name: grant.email.split("@")[0],
            nonce: grant.nonce || undefined,
          },
        }),
      }),
    });
  }
  if (key === "POST /revoke") {
    const token = await unseal<GoogleAccessTokenPayload | GoogleRefreshTokenPayload>(
      url.searchParams.get("token") || "",
      deps.sealKey,
    );
    if (token?.t === "google-refresh") await deps.state.revokeToken(token.jti);
    else if (token?.t !== "google-access") return googleError("invalid_token");
    return Response.json({});
  }
  if (key === "GET /oauth2/v2/userinfo" || key === "GET /gmail/v1/users/me/profile") {
    const bearer = /^Bearer\s+(\S+)$/i.exec(request.headers.get("authorization") ?? "")?.[1];
    const token = await unseal<GoogleAccessTokenPayload>(bearer || "", deps.sealKey);
    if (
      token?.t !== "google-access" ||
      token.exp <= nowSeconds() ||
      token.epoch !== accessTokenEpochFor(await deps.state.getState(), token.clientId)
    )
      return Response.json(
        { error: { code: 401, message: "Invalid Credentials", status: "UNAUTHENTICATED" } },
        { status: 401 },
      );
    if (key === "GET /gmail/v1/users/me/profile")
      return Response.json({ emailAddress: token.email, messagesTotal: 0, historyId: "1" });
    return Response.json({
      id: String(fakeUserIdOf(token.email)),
      email: token.email,
      name: token.email.split("@")[0],
    });
  }
  return null;
}
