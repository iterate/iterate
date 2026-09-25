// test-link-admins.ts — WHO MAY REDEEM A PREVIEW'S SIGN-IN LINK (test-link.ts): a link sits in a
// public PR body, so on a preview it is no credential. Before it signs anyone in, the browser signs
// in at another iterate deployment — `login.testLink.admins.issuer`, prd for a preview — through an
// ordinary OAuth code flow whose one resource is that issuer's `/oauth2/userinfo`: the grant can
// read who the person is and nothing else (api.ts `userinfoResponse`; `/api` and `/mcp` refuse its
// token by audience, RFC 8707). This deployment is the issuer's CIMD client, its metadata document
// served here (`testLinkClientMetadata`), so no preview is registered anywhere by hand. The token is
// read once and revoked at once; the issuer's grant ends in ten minutes besides (consent.ts).
//
// The flow's state lives in one cookie signed with this deployment's key: the link's own token, the
// OAuth `state` and PKCE verifier, for ten minutes. Nothing is stored server-side.

import * as oauth from "oauth4webapi";
import { z } from "zod";
import { cookieValueOf } from "iterate/lib";
import { authorizationCodeRequest, authorizationServer } from "iterate/oauth";
import { sha256Hex, signClaims, verifyClaims } from "./caller.ts";
import { USERINFO_PATH } from "./app-config.ts";
import { TEST_LINK_PATH } from "./test-link.ts";

/** Where the issuer sends the browser back, and where this deployment's CIMD document is. */
export const TEST_LINK_CALLBACK_PATH = `${TEST_LINK_PATH}/callback`;
export const TEST_LINK_CLIENT_PATH = `${TEST_LINK_PATH}/client.json`;

/** The cookie holding one browser's pending check. `__Host-`: this origin's alone. */
const FLOW_COOKIE = "__Host-iterate-test-link";
const FLOW_MS = 10 * 60_000;

/** This deployment as the admin issuer's OAuth client: a public client (PKCE, no secret) whose one
 *  redirect is the callback. The issuer fetches it by its URL, the client id (CIMD). */
export function testLinkClientMetadata(platformOrigin: string) {
  return {
    client_id: `${platformOrigin}${TEST_LINK_CLIENT_PATH}`,
    client_name: `${new URL(platformOrigin).host} sign-in link`,
    client_uri: platformOrigin,
    logo_uri: `${platformOrigin}/iterate-logo.svg`,
    redirect_uris: [`${platformOrigin}${TEST_LINK_CALLBACK_PATH}`],
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code"],
    response_types: ["code"],
  };
}

const Flow = z.object({
  v: z.literal(1),
  /** the link's own token (`?t=`), redeemed once the admin is known */
  t: z.string(),
  state: z.string(),
  verifier: z.string(),
  exp: z.number(),
});

/** Send the browser to sign in at `issuer`, asking only who they are: the authorization URL, and the
 *  cookie that remembers the link `token` meanwhile. */
export async function startAdminCheck(input: {
  issuer: string;
  platformOrigin: string;
  key: string;
  token: string;
}) {
  const { url, state, verifier } = await authorizationCodeRequest({
    issuer: input.issuer,
    clientId: `${input.platformOrigin}${TEST_LINK_CLIENT_PATH}`,
    redirectUri: `${input.platformOrigin}${TEST_LINK_CALLBACK_PATH}`,
    resources: [`${input.issuer}${USERINFO_PATH}`],
  });
  const flow = await signClaims(
    { v: 1, t: input.token, state, verifier, exp: Date.now() + FLOW_MS } satisfies z.infer<
      typeof Flow
    >,
    await flowSecretOf(input.key),
  );
  return {
    location: url.href,
    setCookie: `${FLOW_COOKIE}=${flow}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${FLOW_MS / 1000}`,
  };
}

/** The cookie that ends a check, whatever its outcome. */
export const clearAdminCheckCookie = `${FLOW_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;

/** THE ISSUER'S ANSWER at the callback: the state checked against this browser's cookie, the code
 *  exchanged, the email read from `/oauth2/userinfo`, the token revoked. The link token the check
 *  was started for comes back with the email; a refusal is a sentence for the person. */
export async function finishAdminCheck(input: {
  issuer: string;
  platformOrigin: string;
  key: string;
  request: Request;
}): Promise<{ email: string; token: string } | { error: string }> {
  const cookie = cookieValueOf(input.request.headers.get("cookie"), FLOW_COOKIE);
  const flow = Flow.safeParse(await verifyClaims(cookie || "", await flowSecretOf(input.key)));
  if (!flow.success || flow.data.exp <= Date.now())
    return { error: "This sign-in expired or began in another browser. Open the link again." };
  // the library serves revocation at its token endpoint (RFC 7009)
  const as = { ...authorizationServer(input.issuer) };
  as.revocation_endpoint = as.token_endpoint;
  const client: oauth.Client = { client_id: `${input.platformOrigin}${TEST_LINK_CLIENT_PATH}` };
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
    return { error: "This sign-in expired or began in another browser. Open the link again." };
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
      `${input.platformOrigin}${TEST_LINK_CALLBACK_PATH}`,
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
    return { email, token: flow.data.t };
  } finally {
    // read once: the token has no further use here
    await oauth
      .revocationRequest(as, client, oauth.None(), tokens.access_token, {
        signal: AbortSignal.timeout(10_000),
      })
      .then((response) => response.body?.cancel())
      .catch((error: unknown) =>
        console.warn({ event: "test-link.userinfo-token-not-revoked", message: String(error) }),
      );
  }
}

/** The flow cookie's signing secret: `secrets.key` under its own label, as test-link.ts derives its
 *  own, so no two uses share a key. */
const flowSecretOf = (key: string) => sha256Hex(`iterate-test-link-admin-check:${key}`);
