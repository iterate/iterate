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
 * The OAuth steps are the fakes' one authorization server (authorization-server.ts).
 */
import { fakeAuthorizationServer, redirectTo, tokenClient } from "./authorization-server.ts";
import { accountPicker, discoveryDocument, jwks, signIdToken } from "./oidc.ts";
import { fakeUserIdOf, type ShopDeps } from "./state.ts";

interface GoogleGrant {
  email: string;
  scope: string;
  /** The OpenID nonce to echo in the ID token. */
  nonce?: string;
  /** The consent prompt was shown: only then does a refresh token come back. */
  consent?: boolean;
}

const googleError = (error: string, status = 400) => Response.json({ error }, { status });

/** Google's paths on this origin, or null when the request is not one of them. */
export async function handleGoogleRequest(
  request: Request,
  deps: ShopDeps,
): Promise<Response | null> {
  const url = new URL(request.url);
  const key = `${request.method} ${url.pathname}`;
  const google = fakeAuthorizationServer<GoogleGrant>(deps, "google");
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
    const refusal = await google.authorizeRefusal(query.client_id || "", query.redirect_uri || "");
    if (refusal) return refusal;
    // `prompt` is a space-separated list (`select_account consent`)
    const prompts = (query.prompt || "").split(" ");
    if (prompts.includes("select_account") && !query.email && !query.login_hint)
      return accountPicker(url, ["email"]);
    const code = await google.code({
      clientId: query.client_id!,
      redirectUri: query.redirect_uri!,
      codeChallenge: query.code_challenge,
      grant: {
        email:
          query.email || query.login_hint || `user-${crypto.randomUUID().slice(0, 8)}@petshop.test`,
        scope: query.scope || "openid email profile",
        nonce: query.nonce,
        consent: prompts.includes("consent"),
      },
    });
    return redirectTo(query.redirect_uri!, { code, state: query.state });
  }
  if (key === "POST /token") {
    const form = Object.fromEntries(new URLSearchParams(await request.text()));
    const client = await tokenClient(deps, request, form);
    if (!client || client.client.public) return googleError("invalid_client", 401);
    let grant: GoogleGrant;
    if (form.grant_type === "authorization_code") {
      const redeemed = await google.redeemCode(form.code || "", {
        ...client,
        redirectUri: form.redirect_uri,
        codeVerifier: form.code_verifier,
      });
      if ("refused" in redeemed)
        return googleError(
          redeemed.refused === "redirect_uri mismatch" ? "redirect_uri_mismatch" : "invalid_grant",
        );
      grant = redeemed.grant;
    } else if (form.grant_type === "refresh_token") {
      const refresh = await google.openRefreshToken(form.refresh_token || "", client.clientId);
      if (!refresh) return googleError("invalid_grant");
      // a refresh answers no new refresh token, nor an ID token's nonce
      grant = { email: refresh.grant.email, scope: refresh.grant.scope };
    } else return googleError("unsupported_grant_type");
    const ttlSeconds = client.client.accessTokenTtlSeconds;
    return Response.json({
      access_token: await google.accessToken(client.clientId, grant, ttlSeconds),
      expires_in: ttlSeconds,
      scope: grant.scope,
      token_type: "Bearer",
      ...(grant.consent && { refresh_token: await google.refreshToken(client.clientId, grant) }),
      ...(grant.scope.split(" ").includes("openid") && {
        id_token: await signIdToken(deps, {
          issuer: url.origin,
          clientId: client.clientId,
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
    const token = url.searchParams.get("token") || "";
    const known =
      (await google.revokeRefreshToken(token)) || (await google.openAccessToken(token)) !== null;
    return known ? Response.json({}) : googleError("invalid_token");
  }
  if (key === "GET /oauth2/v2/userinfo" || key === "GET /gmail/v1/users/me/profile") {
    const bearer = /^Bearer\s+(\S+)$/i.exec(request.headers.get("authorization") ?? "")?.[1];
    const access = await google.openAccessToken(bearer || "");
    if (!access)
      return Response.json(
        { error: { code: 401, message: "Invalid Credentials", status: "UNAUTHENTICATED" } },
        { status: 401 },
      );
    const { email } = access.grant;
    if (key === "GET /gmail/v1/users/me/profile")
      return Response.json({ emailAddress: email, messagesTotal: 0, historyId: "1" });
    return Response.json({ id: String(fakeUserIdOf(email)), email, name: email.split("@")[0] });
  }
  return null;
}
