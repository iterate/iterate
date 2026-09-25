// src/integrations/google.ts — GOOGLE: a connection is one Google account (connections.ts). Its
// tokens, and for a project's own OAuth client its `clientId` and `clientSecret`, live in
// `/secrets/google-<connection>`, an `oauth-refresh-token` secret: with iterate's client the refresh
// attaches that client inside the secret's facet (secret/durable-object.ts), with the project's the
// material holds it. Offline access with a consent prompt, so Google issues a refresh token; granted
// scopes included, so asking for more on an existing connection keeps what it had.
//   connectGoogle      → the consent URL (`itx.secrets.beginOAuth`)
//   finishGoogleConnect → userinfo names the account, then `google/connected` on `/`
//   disconnectGoogle   → the grant revoked, the secret deleted, `google/disconnected`
// Google sends no webhooks here, so nothing is routed.
import { codedError } from "iterate/lib";
import { appConfigOf, DEFAULT_GOOGLE_SCOPES } from "../app-config.ts";
import { SECRET_OAUTH_TTL_MS } from "../secret-oauth.ts";
import { isRecord } from "../secrets.ts";
import {
  appendPlatformFact,
  attemptKeyOf,
  ownerEgress,
  tokenSecretPathOf,
  type ConnectionAttempt,
  type IntegrationScope,
} from "./connections.ts";

/** Google's token endpoint origin — what a project's own Google client's secret is pinned to. */
const GOOGLE_TOKEN_ORIGIN = "https://oauth2.googleapis.com";

/** WHERE GOOGLE ANSWERS: Google's own endpoints when `googleOrigin` is unset, else every path at
 *  that one origin (a fake's). `urls` is the token secret's pin: the token endpoint and every API
 *  the default scopes reach (userinfo, Calendar and Drive on www, Gmail, Docs). */
export function googleEndpointsOf(googleOrigin?: string | null) {
  if (googleOrigin)
    return {
      authorizationEndpoint: `${googleOrigin}/o/oauth2/v2/auth`,
      tokenEndpoint: `${googleOrigin}/token`,
      revocationEndpoint: `${googleOrigin}/revoke`,
      userinfoEndpoint: `${googleOrigin}/oauth2/v2/userinfo`,
      urls: [googleOrigin],
    };
  return {
    authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenEndpoint: `${GOOGLE_TOKEN_ORIGIN}/token`,
    revocationEndpoint: `${GOOGLE_TOKEN_ORIGIN}/revoke`,
    userinfoEndpoint: "https://www.googleapis.com/oauth2/v2/userinfo",
    urls: [
      GOOGLE_TOKEN_ORIGIN,
      "https://www.googleapis.com",
      "https://gmail.googleapis.com",
      "https://docs.googleapis.com",
    ],
  };
}

/** Where Google answers — null for Google itself — and the scopes asked for: iterate's client's
 *  (`googleOrigin` is a fake's on a preview), or the pin the project's own client's secret was set
 *  with (Google's token origin, or a fake's). */
async function googleClientOf(
  scope: IntegrationScope,
  client: ConnectionAttempt["client"],
  connection: string,
): Promise<{ origin: string | null; scopes: readonly string[] }> {
  if (client === "iterate") {
    const google = appConfigOf(scope.env).integrations.google;
    if (!google)
      throw codedError(
        "INVALID_INPUT",
        "This deployment has no Google client (APP_CONFIG integrations.google) — use your own.",
      );
    return { origin: google.googleOrigin || null, scopes: google.scopes };
  }
  const secretPath = tokenSecretPathOf("google", connection);
  const secrets = await scope.withItx((itx) => itx.secrets.list());
  const pin = secrets.find((secret) => secret.path === secretPath)?.urls[0];
  if (!pin)
    throw codedError(
      "INVALID_INPUT",
      `Set ${secretPath} to your Google OAuth client's { clientId, clientSecret }, pinned to ${GOOGLE_TOKEN_ORIGIN}, first.`,
    );
  return { origin: pin === GOOGLE_TOKEN_ORIGIN ? null : pin, scopes: DEFAULT_GOOGLE_SCOPES };
}

export async function connectGoogle(
  scope: IntegrationScope,
  input: {
    connection: string;
    client: ConnectionAttempt["client"];
    next?: string;
    /** More scopes than the client's default: an incremental consent keeps what was granted. */
    scopes?: readonly string[];
    /** The account an existing connection holds: the consent must come back as it, and Google is
     *  hinted to ask it. */
    expectAccount?: { externalId: string; account: string };
  },
): Promise<{ authorizationUrl: string }> {
  const { connection, client, expectAccount } = input;
  const { origin, scopes } = await googleClientOf(scope, client, connection);
  const endpoints = googleEndpointsOf(origin);
  const { authorizationUrl } = await scope.withItx((itx) =>
    itx.secrets.beginOAuth(tokenSecretPathOf("google", connection), {
      authorizationEndpoint: endpoints.authorizationEndpoint,
      tokenEndpoint: endpoints.tokenEndpoint,
      client: client === "iterate" ? { platform: "google" } : { project: "google" },
      scope: [...new Set([...scopes, ...(input.scopes || [])])].join(" "),
      urls: endpoints.urls,
      extra: {
        access_type: "offline",
        prompt: "consent",
        include_granted_scopes: "true",
        ...(expectAccount && { login_hint: expectAccount.account }),
      },
      next: input.next,
      expectAccount: expectAccount?.externalId,
    }),
  );
  const attempt: ConnectionAttempt = {
    client,
    origin: origin || "",
    until: Date.now() + SECRET_OAUTH_TTL_MS,
  };
  await scope.storage.put(attemptKeyOf("google", connection), attempt);
  return { authorizationUrl };
}

/** A Google call with one of the token secret's fields, through egress: the revoke takes the token
 *  in the query, every API as the bearer. */
function googleCall(
  scope: IntegrationScope,
  url: string,
  connection: string,
  field: "accessToken" | "refreshToken",
) {
  const placeholder = `getSecret("${tokenSecretPathOf("google", connection)}", { field: "${field}" })`;
  return ownerEgress(
    scope.env,
    scope,
    field === "refreshToken"
      ? new Request(`${url}?token=${placeholder}`, { method: "POST" })
      : new Request(url, { headers: { authorization: `Bearer ${placeholder}` } }),
  );
}

export async function finishGoogleConnect(
  scope: IntegrationScope,
  connection: string,
  attempt: ConnectionAttempt,
): Promise<void> {
  const endpoints = googleEndpointsOf(attempt.origin);
  const response = await googleCall(scope, endpoints.userinfoEndpoint, connection, "accessToken");
  const userinfo: unknown = await response.json().catch(() => null);
  if (!response.ok || !isRecord(userinfo) || typeof userinfo.id !== "string")
    throw new Error(`Google's userinfo answered ${response.status}`);
  await appendPlatformFact(scope.env, scope.projectId, scope.rootPath, {
    type: "events.iterate.com/google/connected",
    payload: {
      connection,
      client: attempt.client,
      account: typeof userinfo.email === "string" ? userinfo.email : userinfo.id,
      externalId: userinfo.id,
    },
  });
}

export async function disconnectGoogle(
  scope: IntegrationScope,
  connection: string,
  client: ConnectionAttempt["client"] | null,
): Promise<void> {
  // revoking the refresh token ends the whole grant; a grant already dead is the goal
  if (client)
    await googleClientOf(scope, client, connection)
      .then(({ origin }) =>
        googleCall(scope, googleEndpointsOf(origin).revocationEndpoint, connection, "refreshToken"),
      )
      .then((response) => response.body?.cancel())
      .catch(() => {});
  // a secret never set (consent never finished) throws, having dropped the attempt in flight
  await scope
    .withItx((itx) => itx.secrets.delete(tokenSecretPathOf("google", connection)))
    .catch(() => {});
  await scope.storage.delete(attemptKeyOf("google", connection));
  await appendPlatformFact(scope.env, scope.projectId, scope.rootPath, {
    type: "events.iterate.com/google/disconnected",
    payload: { connection },
  });
}
