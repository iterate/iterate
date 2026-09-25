// src/integrations/cloudflare.ts — CLOUDFLARE: a connection is one Cloudflare account (connections.ts),
// through iterate's OAuth client alone (APP_CONFIG `integrations.cloudflare`, the client that signs
// people in too). Its tokens live in `/secrets/cloudflare-<connection>`, an `oauth-refresh-token`
// secret whose refresh attaches the client inside the secret's facet when Cloudflare issued a
// refresh token (`offline_access`). Outbound calls carry
// `getSecret("/secrets/cloudflare-<c>", { field: "accessToken" })` to api.cloudflare.com.
//   connectCloudflare      → the consent URL (`itx.secrets.beginOAuth`)
//   finishCloudflareConnect → `GET /client/v4/user` names the account, then `cloudflare/connected`
//   disconnectCloudflare   → the secret deleted, `cloudflare/disconnected`
import { codedError } from "iterate/lib";
import { appConfigOf } from "../app-config.ts";
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

/** WHERE CLOUDFLARE ANSWERS: dash.cloudflare.com issues (OpenID Connect) and api.cloudflare.com
 *  serves the API; with `cloudflareOrigin` set (a fake's), one origin serves both, its issuer at
 *  `<origin>/cloudflare` so it can share the origin with Google's fake. `urls` is the token secret's
 *  pin. */
export function cloudflareEndpointsOf(cloudflareOrigin?: string | null) {
  const issuer = cloudflareOrigin
    ? `${cloudflareOrigin}/cloudflare`
    : "https://dash.cloudflare.com";
  const apiOrigin = cloudflareOrigin || "https://api.cloudflare.com";
  return {
    issuer,
    authorizationEndpoint: `${issuer}/oauth2/auth`,
    tokenEndpoint: `${issuer}/oauth2/token`,
    userEndpoint: `${apiOrigin}/client/v4/user`,
    urls: [...new Set([new URL(issuer).origin, apiOrigin])],
  };
}

export async function connectCloudflare(
  scope: IntegrationScope,
  input: {
    connection: string;
    client: ConnectionAttempt["client"];
    next?: string;
    scopes?: readonly string[];
    expectAccount?: string;
  },
): Promise<{ authorizationUrl: string }> {
  const cloudflare = appConfigOf(scope.env).integrations.cloudflare;
  if (input.client !== "iterate" || !cloudflare)
    throw codedError(
      "INVALID_INPUT",
      "Cloudflare connects through this deployment's Cloudflare client (APP_CONFIG integrations.cloudflare) alone.",
    );
  const endpoints = cloudflareEndpointsOf(cloudflare.cloudflareOrigin);
  const { authorizationUrl } = await scope.withItx((itx) =>
    itx.secrets.beginOAuth(tokenSecretPathOf("cloudflare", input.connection), {
      authorizationEndpoint: endpoints.authorizationEndpoint,
      tokenEndpoint: endpoints.tokenEndpoint,
      client: { platform: "cloudflare" },
      clientAuth: "client_secret_post",
      scope: [...new Set([...cloudflare.scopes, ...(input.scopes || [])])].join(" "),
      urls: endpoints.urls,
      next: input.next,
      expectAccount: input.expectAccount,
    }),
  );
  const attempt: ConnectionAttempt = {
    client: "iterate",
    origin: cloudflare.cloudflareOrigin || "",
    until: Date.now() + SECRET_OAUTH_TTL_MS,
  };
  await scope.storage.put(attemptKeyOf("cloudflare", input.connection), attempt);
  return { authorizationUrl };
}

export async function finishCloudflareConnect(
  scope: IntegrationScope,
  connection: string,
  attempt: ConnectionAttempt,
): Promise<void> {
  const endpoints = cloudflareEndpointsOf(attempt.origin);
  const response = await ownerEgress(
    scope.env,
    scope,
    new Request(endpoints.userEndpoint, {
      headers: {
        authorization: `Bearer getSecret("${tokenSecretPathOf("cloudflare", connection)}", { field: "accessToken" })`,
      },
    }),
  );
  const body: unknown = await response.json().catch(() => null);
  const user = isRecord(body) && isRecord(body.result) ? body.result : null;
  if (!response.ok || typeof user?.id !== "string")
    throw new Error(`Cloudflare's /user answered ${response.status}`);
  await appendPlatformFact(scope.env, scope.projectId, scope.rootPath, {
    type: "events.iterate.com/cloudflare/connected",
    payload: {
      connection,
      client: "iterate",
      account: typeof user.email === "string" ? user.email : user.id,
      externalId: user.id,
    },
  });
}

export async function disconnectCloudflare(
  scope: IntegrationScope,
  connection: string,
): Promise<void> {
  // Cloudflare's revocation takes the token in the body, which egress never fills in: deleting the
  // secret is the disconnect (the person revokes the grant at dash.cloudflare.com).
  const secretPath = tokenSecretPathOf("cloudflare", connection);
  await scope.withItx((itx) => itx.secrets.delete(secretPath)).catch(() => {});
  await scope.storage.delete(attemptKeyOf("cloudflare", connection));
  await appendPlatformFact(scope.env, scope.projectId, scope.rootPath, {
    type: "events.iterate.com/cloudflare/disconnected",
    payload: { connection },
  });
}
