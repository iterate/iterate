import * as oauth from "oauth4webapi";
import { z } from "zod";
import { errorCode, sameOriginPath } from "iterate/next/lib";
import { cookieValueOf, signClaims, verifyClaims } from "iterate/next/principal";
import type { Env } from "./control-plane.ts";
import { appConfigOf, platformOriginOf, sessionSigningSecretOf } from "./app-config.ts";
import { startIssuerSession } from "./issuer-session.ts";
import { directory } from "./directory.ts";

const providers = {
  google: {
    name: "Google",
    issuer: new URL("https://accounts.google.com"),
    path: "/.auth/identity",
    scope: "openid email profile",
  },
  cloudflare: {
    name: "Cloudflare",
    issuer: new URL("https://dash.cloudflare.com"),
    path: "/.auth/identity/cloudflare",
    // Cloudflare returns email + email_verified with these scopes. It rejects email/profile.
    scope: "openid user-details.read",
  },
};
const cookieAttributes = "HttpOnly; Secure; SameSite=Lax; Path=/";
const Flow = z.object({
  kind: z.literal("identity-login"),
  provider: z.enum(["google", "cloudflare"]),
  clientId: z.string(),
  redirectUri: z.string(),
  state: z.string(),
  nonce: z.string(),
  verifier: z.string(),
  next: z.string(),
  expiresAt: z.number(),
});
const VerifiedIdentity = z.object({
  sub: z.string().min(1),
  email: z.email(),
  email_verified: z.literal(true),
  /** the account's picture and display name (the `profile` scope): the consent page's "signed in
   *  as", and the onboarding step's suggested organization name */
  picture: z.url().optional(),
  name: z.string().optional(),
});

/** The upstream provider proves identity; its credentials never authorize our API. */
export async function identityResponse(request: Request, env: Env) {
  const url = new URL(request.url);
  const provider = url.pathname.startsWith("/.auth/identity/cloudflare") ? "cloudflare" : "google";
  const settings = providers[provider];
  if (![settings.path, `${settings.path}/callback`].includes(url.pathname)) return null;
  if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });
  const config = appConfigOf(env);
  const credentials = config.login[provider];
  if (!credentials)
    return new Response(`${settings.name} sign-in is not configured`, { status: 503 });
  const issuer = settings.issuer;
  const cookie = `__Host-itx-${provider}-identity-flow`;
  const as = await oauth
    .discoveryRequest(issuer)
    .then((response) => oauth.processDiscoveryResponse(issuer, response));
  const client = { client_id: credentials.clientId };
  const platformOrigin = platformOriginOf(config, request);
  const redirectUri = `${platformOrigin}${settings.path}/callback`;
  const signingSecret = await sessionSigningSecretOf(config);
  const headers = new Headers({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
  if (url.pathname === settings.path) {
    const flow = {
      kind: "identity-login",
      provider,
      clientId: client.client_id,
      redirectUri,
      state: oauth.generateRandomState(),
      nonce: oauth.generateRandomNonce(),
      verifier: oauth.generateRandomCodeVerifier(),
      next: sameOriginPath(url.searchParams.get("next") || "/", platformOrigin),
      expiresAt: Date.now() + 600_000,
    };
    const authorization = new URL(as.authorization_endpoint!);
    authorization.search = new URLSearchParams({
      client_id: client.client_id,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: settings.scope,
      state: flow.state,
      nonce: flow.nonce,
      code_challenge: await oauth.calculatePKCECodeChallenge(flow.verifier),
      code_challenge_method: "S256",
    }).toString();
    const flowCookie = `${cookie}=${await signClaims(flow, signingSecret)}; ${cookieAttributes}; Max-Age=600`;
    if (new TextEncoder().encode(flowCookie).length > 4096)
      return new Response("The sign-in request exceeds the browser cookie limit.", { status: 400 });
    headers.set("Set-Cookie", flowCookie);
    headers.set("Location", authorization.href);
    return new Response(null, { status: 302, headers });
  }
  headers.append("Set-Cookie", `${cookie}=; ${cookieAttributes}; Max-Age=0`);
  const signed = cookieValueOf(request.headers.get("cookie"), cookie);
  const flow = Flow.safeParse(signed && (await verifyClaims(signed, signingSecret)));
  if (
    !flow.success ||
    flow.data.expiresAt <= Date.now() ||
    flow.data.provider !== provider ||
    flow.data.clientId !== client.client_id ||
    flow.data.redirectUri !== redirectUri
  )
    return new Response("Sign-in expired. Please start again.", { status: 400, headers });
  try {
    const parameters = oauth.validateAuthResponse(as, client, url, flow.data.state);
    const response = await oauth.authorizationCodeGrantRequest(
      as,
      client,
      oauth.ClientSecretPost(credentials.clientSecret.exposeSecret()),
      parameters,
      redirectUri,
      flow.data.verifier,
    );
    const tokens = await oauth.processAuthorizationCodeResponse(as, client, response, {
      expectedNonce: flow.data.nonce,
      requireIdToken: true,
    });
    await oauth.validateApplicationLevelSignature(as, response);
    const identity = VerifiedIdentity.safeParse(oauth.getValidatedIdTokenClaims(tokens));
    if (!identity.success)
      return new Response(`${settings.name} must verify your email before you can sign in.`, {
        status: 403,
        headers,
      });
    // Resolve the provider and stable subject together; email changes cannot change the actor.
    const user = await directory(env.DB).upsertIdentityUser(
      provider,
      identity.data.sub,
      identity.data.email,
    );
    const session = await startIssuerSession(env, request, user, flow.data.next, {
      picture: identity.data.picture,
      name: identity.data.name,
    });
    headers.append("Set-Cookie", session.setCookie);
    headers.set("Location", session.location);
    return new Response(null, { status: 303, headers });
  } catch (error) {
    if (errorCode(error) === "IDENTITY_CONFLICT")
      return new Response(error instanceof Error ? error.message : "Account identity conflict", {
        status: 409,
        headers,
      });
    if (
      error instanceof oauth.AuthorizationResponseError ||
      error instanceof oauth.OperationProcessingError ||
      (error instanceof oauth.ResponseBodyError && error.error === "invalid_grant")
    )
      return new Response("Sign-in was refused or expired. Please start again.", {
        status: 400,
        headers,
      });
    throw error;
  }
}
