import * as oauth from "oauth4webapi";
import { z } from "zod";
import type { Env } from "./control-plane.ts";
import { appConfigOf } from "./app-config.ts";
import { directory } from "./directory.ts";
import { errorCode, sameOriginPath } from "./lib.ts";
import { cookieValueOf, setSessionCookie, signClaims, verifyClaims } from "./principal.ts";

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
});

/** Bare-email fixtures exist only on loopback hosts, never a deployed origin. */
export function isLocalOrigin(origin: string) {
  const { hostname } = new URL(origin);
  return hostname === "localhost" || hostname.endsWith(".localhost") || hostname === "127.0.0.1";
}

/** This is the issuer's identity proof. The console subsequently uses the same
 * browser OAuth client and consent flow as every project app. */
export async function identityDoor(request: Request, env: Env) {
  const url = new URL(request.url);
  if (!["/.auth/identity", "/.auth/identity/callback"].includes(url.pathname)) return null;
  if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });
  const config = appConfigOf(env);
  if (!config.googleClientId || !config.googleClientSecret)
    return new Response("Google sign-in is not configured", { status: 503 });
  const as = await oauth
    .discoveryRequest(issuer)
    .then((response) => oauth.processDiscoveryResponse(issuer, response));
  const client = { client_id: config.googleClientId };
  const redirectUri = `${config.platformOrigin}/.auth/identity/callback`;
  const headers = new Headers({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
  if (url.pathname === "/.auth/identity") {
    const flow = {
      kind: "google-login",
      state: oauth.generateRandomState(),
      nonce: oauth.generateRandomNonce(),
      verifier: oauth.generateRandomCodeVerifier(),
      next: sameOriginPath(url.searchParams.get("next") || "/", config.platformOrigin),
      expiresAt: Date.now() + 600_000,
    };
    const authorization = new URL(as.authorization_endpoint!);
    authorization.search = new URLSearchParams({
      client_id: client.client_id,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: "openid email",
      state: flow.state,
      nonce: flow.nonce,
      code_challenge: await oauth.calculatePKCECodeChallenge(flow.verifier),
      code_challenge_method: "S256",
    }).toString();
    headers.set(
      "Set-Cookie",
      `${cookie}=${await signClaims(flow, config.sessionSecret)}; ${cookieAttributes}; Max-Age=600`,
    );
    headers.set("Location", authorization.href);
    return new Response(null, { status: 302, headers });
  }
  headers.append("Set-Cookie", `${cookie}=; ${cookieAttributes}; Max-Age=0`);
  const signed = cookieValueOf(request.headers.get("cookie"), cookie);
  const flow = Flow.safeParse(signed && (await verifyClaims(signed, config.sessionSecret)));
  if (!flow.success || flow.data.expiresAt <= Date.now())
    return new Response("Sign-in expired. Please start again.", { status: 400, headers });
  try {
    const parameters = oauth.validateAuthResponse(as, client, url, flow.data.state);
    const response = await oauth.authorizationCodeGrantRequest(
      as,
      client,
      oauth.ClientSecretPost(config.googleClientSecret),
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
    headers.append(
      "Set-Cookie",
      await setSessionCookie(
        {
          sub: user.id,
          email: user.email,
          iat: Math.floor(Date.now() / 1000),
        },
        config.sessionSecret,
      ),
    );
    headers.set("Location", flow.data.next);
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
