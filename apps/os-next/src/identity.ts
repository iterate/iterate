import * as oauth from "oauth4webapi";
import { z } from "zod";
import { errorCode, sameOriginPath } from "iterate/next/lib";
import { cookieValueOf, signClaims, verifyClaims } from "iterate/next/principal";
import type { Env } from "./env.ts";
import { appConfigOf, platformAddressesOf, sessionSigningSecretOf } from "./app-config.ts";
import { startIssuerSession } from "./issuer-session.ts";
import { directory } from "./directory.ts";

const issuer = new URL("https://accounts.google.com");
const cookie = "__Host-itx-identity-flow";
const cookieAttributes = "HttpOnly; Secure; SameSite=Lax; Path=/";
const Flow = z.object({
  kind: z.literal("google-login"),
  state: z.string(),
  nonce: z.string(),
  verifier: z.string(),
  next: z.string(),
  expiresAt: z.number(),
});
const GoogleIdentity = z.object({
  sub: z.string().regex(/^\d+$/),
  email: z.email(),
  email_verified: z.literal(true),
  /** the account's picture and display name (the `profile` scope): the consent page's "signed in
   *  as", and the onboarding step's suggested organization name */
  picture: z.url().optional(),
  name: z.string().optional(),
});

/** Google proves identity to our issuer; its credentials never authorize our API. */
export async function identityDoor(request: Request, env: Env) {
  const url = new URL(request.url);
  if (!["/.auth/identity", "/.auth/identity/callback"].includes(url.pathname)) return null;
  if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });
  const config = appConfigOf(env);
  const google = config.login.google;
  if (!google) return new Response("Google sign-in is not configured", { status: 503 });
  const as = await oauth
    .discoveryRequest(issuer)
    .then((response) => oauth.processDiscoveryResponse(issuer, response));
  const client = { client_id: google.clientId };
  const { platformOrigin } = platformAddressesOf(env, request);
  const redirectUri = `${platformOrigin}/.auth/identity/callback`;
  const signingSecret = await sessionSigningSecretOf(config);
  const headers = new Headers({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
  if (url.pathname === "/.auth/identity") {
    const flow = {
      kind: "google-login",
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
      scope: "openid email profile",
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
  if (!flow.success || flow.data.expiresAt <= Date.now())
    return new Response("Sign-in expired. Please start again.", { status: 400, headers });
  try {
    const parameters = oauth.validateAuthResponse(as, client, url, flow.data.state);
    const response = await oauth.authorizationCodeGrantRequest(
      as,
      client,
      oauth.ClientSecretPost(google.clientSecret.exposeSecret()),
      parameters,
      redirectUri,
      flow.data.verifier,
    );
    const tokens = await oauth.processAuthorizationCodeResponse(as, client, response, {
      expectedNonce: flow.data.nonce,
      requireIdToken: true,
    });
    await oauth.validateApplicationLevelSignature(as, response);
    const identity = GoogleIdentity.safeParse(oauth.getValidatedIdTokenClaims(tokens));
    if (!identity.success)
      return new Response("Google must verify your email before you can sign in.", {
        status: 403,
        headers,
      });
    // Google's stable subject owns the account; an email change cannot change its actor.
    const user = await directory(env.DB).upsertGoogleUser(identity.data.sub, identity.data.email);
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
