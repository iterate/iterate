// admin-sign-in.ts — A DEPLOYMENT'S ADMINS SIGN IN THROUGH ANOTHER ISSUER: `login.adminIssuer` names
// an iterate deployment (prd, for every per-commit deployment) whose word this one takes on who a
// browser is, for its `admins` alone. The sign-in page's "Continue with <issuer host>" starts an
// ordinary OAuth code flow at that issuer whose one resource is its `/oauth2/userinfo`: the grant can
// read who the person is and nothing else (api.ts `userinfoResponse`; `/api` and `/mcp` refuse its
// token by audience, RFC 8707). An address this deployment's `admins` lists is signed in here as
// themselves; anyone else is refused. A PR deployment's admins are prd's (envs.ts
// `previewDeployment`), so a PR's reviewer signs in with the prd session they already have, then
// signs an app in as the PR's test person from the consent page ("Sign in as someone else…",
// consent.ts): what the PR body's `Sign in ↗` links open (scripts/os/preview.ts).
//
// This deployment is the issuer's CIMD client, its metadata document served here
// (`adminSignInClientMetadata`), so no preview is registered anywhere by hand. The token is read
// once and revoked at once; the issuer's grant ends in ten minutes besides (consent.ts). The flow's
// state lives in one cookie signed like every platform claim set (app-config.ts
// `sessionSigningSecretOf`, kind `admin-sign-in`): where the browser goes next, the OAuth `state`
// and the PKCE verifier, for ten minutes. Nothing is stored server-side.

import * as oauth from "oauth4webapi";
import { z } from "zod";
import { cookieValueOf, sameOriginPath } from "iterate/lib";
import { authorizationCodeRequest, authorizationServer } from "iterate/oauth";
import { emailAllowed, EMAIL_NOT_ALLOWED_MESSAGE } from "./allowed-emails.ts";
import {
  appConfigOf,
  platformAddressesOf,
  sessionSigningSecretOf,
  USERINFO_PATH,
} from "./app-config.ts";
import { signClaims, verifyClaims } from "./caller.ts";
import { ControlPlane } from "./control-plane/edge.ts";
import type { Env } from "./env.ts";
import { startIssuerSession } from "./issuer-session.ts";
import { isAdmin } from "./oauth.ts";
import { watchSignInStep } from "./sign-in-watch.ts";

/** Where the sign-in starts (`?next=`, a path on this origin), where the issuer sends the browser
 *  back, and where this deployment's CIMD document is — each answered by worker.ts only where
 *  `login.adminIssuer` is set. */
export const ADMIN_SIGN_IN_PATH = "/.auth/admin-sign-in";
export const ADMIN_SIGN_IN_CALLBACK_PATH = `${ADMIN_SIGN_IN_PATH}/callback`;
export const ADMIN_SIGN_IN_CLIENT_PATH = `${ADMIN_SIGN_IN_PATH}/client.json`;

/** The cookie holding one browser's pending sign-in. `__Host-`: this origin's alone; `itx-`: a
 *  platform cookie, which no project app is handed or may set (browser-client.ts `appCookies`,
 *  worker.ts `withoutPlatformHeaders`) — under paths routing the app shares this origin. */
const FLOW_COOKIE = "__Host-itx-admin-sign-in";
const FLOW_MS = 10 * 60_000;
const clearFlowCookie = `${FLOW_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;

/** The flow cookie's claims; `kind` tells them apart from every other claim set the session-signing
 *  secret signs. */
const Flow = z.object({
  kind: z.literal("admin-sign-in"),
  /** where the browser goes once signed in: a path on this origin */
  next: z.string(),
  state: z.string(),
  verifier: z.string(),
  exp: z.number(),
});

/** This deployment as the admin issuer's OAuth client: a public client (PKCE, no secret) whose one
 *  redirect is the callback. The issuer fetches it by its URL, the client id (CIMD). */
export function adminSignInClientMetadata(platformOrigin: string) {
  return {
    client_id: `${platformOrigin}${ADMIN_SIGN_IN_CLIENT_PATH}`,
    client_name: `${new URL(platformOrigin).host} admin sign-in`,
    client_uri: platformOrigin,
    logo_uri: `${platformOrigin}/iterate-logo.svg`,
    redirect_uris: [`${platformOrigin}${ADMIN_SIGN_IN_CALLBACK_PATH}`],
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code"],
    response_types: ["code"],
  };
}

/** `GET /.auth/admin-sign-in?next=`: send the browser to sign in at `issuer` (`login.adminIssuer`),
 *  asking only who they are, with the cookie that remembers `next` meanwhile. */
export async function adminSignInResponse(request: Request, env: Env, issuer: string) {
  const config = appConfigOf(env);
  const { platformOrigin } = platformAddressesOf(env, request);
  const next = sameOriginPath(
    new URL(request.url).searchParams.get("next") || "/login",
    platformOrigin,
  );
  const { url, state, verifier } = await authorizationCodeRequest({
    issuer,
    clientId: `${platformOrigin}${ADMIN_SIGN_IN_CLIENT_PATH}`,
    redirectUri: `${platformOrigin}${ADMIN_SIGN_IN_CALLBACK_PATH}`,
    resources: [`${issuer}${USERINFO_PATH}`],
  });
  const flow = await signClaims(
    {
      kind: "admin-sign-in",
      next,
      state,
      verifier,
      exp: Date.now() + FLOW_MS,
    } satisfies z.infer<typeof Flow>,
    await sessionSigningSecretOf(config),
  );
  return new Response(null, {
    status: 302,
    headers: {
      location: url.href,
      "set-cookie": `${FLOW_COOKIE}=${flow}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${FLOW_MS / 1000}`,
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    },
  });
}

/** `GET /.auth/admin-sign-in/callback`: `issuer`'s answer. An address `admins` lists is signed in
 *  here as themselves, the issuer session started exactly as a password sign-in starts it, and sent
 *  on to the flow's `next`; anyone else lands back on the sign-in page with why, and every outcome
 *  is logged with the address the issuer vouched for. */
export async function adminSignInCallbackResponse(request: Request, env: Env, issuer: string) {
  const config = appConfigOf(env);
  const refused = (error: string, next = "/login") => {
    const headers = new Headers({
      location: `/login?${new URLSearchParams({ next, error })}`,
      "cache-control": "no-store",
    });
    headers.append("set-cookie", clearFlowCookie);
    return new Response(null, { status: 303, headers });
  };
  const checked = await whoSignedIn({
    issuer,
    platformOrigin: platformAddressesOf(env, request).platformOrigin,
    signingSecret: await sessionSigningSecretOf(config),
    request,
  }).catch((error: unknown) => {
    console.warn({ event: "admin-sign-in.check-failed", message: String(error) });
    return { error: `Could not confirm who you are at ${issuer}. Try again.` };
  });
  if ("error" in checked) return refused(checked.error);
  if (!isAdmin(env, checked.email)) {
    console.warn({ event: "admin-sign-in.refused-not-admin", email: checked.email });
    return refused(`${checked.email} is not an admin here. Sign in another way.`, checked.next);
  }
  if (!emailAllowed(config.login.allowedEmails, checked.email))
    return refused(EMAIL_NOT_ALLOWED_MESSAGE, checked.next);
  const user = await watchSignInStep(
    "ensure-user",
    new ControlPlane(env).ensureUser(checked.email),
  );
  const session = await startIssuerSession(env, request, user, checked.next);
  if ("error" in session) return refused(session.error, checked.next);
  console.info({ event: "admin-sign-in.signed-in", email: checked.email });
  const headers = new Headers({
    location: session.location,
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
  });
  headers.append("set-cookie", session.setCookie);
  headers.append("set-cookie", clearFlowCookie);
  return new Response(null, { status: 302, headers });
}

/** THE ISSUER'S ANSWER at the callback: the state checked against this browser's cookie, the code
 *  exchanged, the email read from `/oauth2/userinfo`, the token revoked. The `next` the sign-in was
 *  started for comes back with the email; a refusal is a sentence for the person. */
async function whoSignedIn(input: {
  issuer: string;
  platformOrigin: string;
  signingSecret: string;
  request: Request;
}): Promise<{ email: string; next: string } | { error: string }> {
  const cookie = cookieValueOf(input.request.headers.get("cookie"), FLOW_COOKIE);
  const flow = Flow.safeParse(await verifyClaims(cookie || "", input.signingSecret));
  if (!flow.success || flow.data.exp <= Date.now())
    return { error: "This sign-in expired or began in another browser. Start it again." };
  // the library serves revocation at its token endpoint (RFC 7009)
  const as = { ...authorizationServer(input.issuer) };
  as.revocation_endpoint = as.token_endpoint;
  const client = { client_id: `${input.platformOrigin}${ADMIN_SIGN_IN_CLIENT_PATH}` };
  let callback: URLSearchParams;
  try {
    callback = oauth.validateAuthResponse(
      as,
      client,
      new URL(input.request.url).searchParams,
      flow.data.state,
    );
  } catch (error) {
    if (error instanceof oauth.AuthorizationResponseError)
      return { error: `Sign-in at ${input.issuer} was cancelled.` };
    return { error: "This sign-in expired or began in another browser. Start it again." };
  }
  const resource = `${input.issuer}${USERINFO_PATH}`;
  const options = {
    additionalParameters: { resource },
    signal: AbortSignal.timeout(10_000),
  } satisfies oauth.TokenEndpointRequestOptions;
  const tokens = await oauth.processAuthorizationCodeResponse(
    as,
    client,
    await oauth.authorizationCodeGrantRequest(
      as,
      client,
      oauth.None(),
      callback,
      `${input.platformOrigin}${ADMIN_SIGN_IN_CALLBACK_PATH}`,
      flow.data.verifier,
      options,
    ),
  );
  try {
    const response = await fetch(resource, {
      headers: { authorization: `Bearer ${tokens.access_token}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`${resource} answered ${response.status}`);
    const { email } = z.object({ email: z.string() }).parse(await response.json());
    return { email, next: flow.data.next };
  } finally {
    // read once: the token has no further use here
    await oauth
      .revocationRequest(as, client, oauth.None(), tokens.access_token, {
        signal: AbortSignal.timeout(10_000),
      })
      .then((response) => response.body?.cancel())
      .catch((error: unknown) =>
        console.warn({ event: "admin-sign-in.userinfo-token-not-revoked", message: String(error) }),
      );
  }
}
