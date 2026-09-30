// X connections use PKCE and rotating OAuth 2.0 tokens in the existing secret infrastructure.
// Account identity comes from /users/me; personal connections require Iterate's client.
import { codedError } from "iterate/lib";
import { z } from "zod";
import { appConfigOf, DEFAULT_X_SCOPES } from "../app-config.ts";
import { SECRET_OAUTH_TTL_MS } from "../secret-oauth.ts";
import type { IntegrationConnectionRow } from "./contract.ts";
import {
  appendConnected,
  connectionPathOf,
  connectionRowOf,
  consentAttemptKeyOf,
  deleteTokenSecret,
  ownerEgress,
  routedWhile,
  tokenSecretPathOf,
  type ConnectionAttempt,
  type IntegrationScope,
} from "./connections.ts";

/** X has no ID token: account identity comes from the authorized /2/users/me response.
 * https://docs.x.com/x-api/users/get-my-user */
export const XUserResponse = z.object({
  data: z.object({ id: z.string().regex(/^\d+$/), username: z.string().min(1) }),
});

/** A test provider serves both endpoints on one origin; live X splits consent and API hosts. */
export function xEndpointsOf(origin?: string | null) {
  const apiOrigin = origin || "https://api.x.com";
  return {
    authorizationEndpoint: `${origin || "https://x.com"}/i/oauth2/authorize`,
    tokenEndpoint: `${apiOrigin}/2/oauth2/token`,
    userEndpoint: `${apiOrigin}/2/users/me`,
    urls: [apiOrigin],
  };
}

/** Begin consent, retaining already granted scopes on a reconnect. */
export async function connectX(
  scope: IntegrationScope,
  input: {
    connection: string;
    client: ConnectionAttempt["client"];
    next?: string;
    scopes?: readonly string[];
    existing?: IntegrationConnectionRow;
    connectToProject?: ConnectionAttempt["connectToProject"];
  },
) {
  if (scope.rootPath !== "/" && input.client !== "iterate")
    throw codedError("INVALID_INPUT", "Link your X identity through Iterate's X app.");
  const app = appConfigOf(scope.env).integrations.x;
  using itx = scope.getItx();
  let origin: string | undefined;
  if (input.client === "iterate") {
    if (!app) throw codedError("INVALID_INPUT", "This deployment has no X OAuth client.");
    origin = app.xOrigin;
  } else {
    const secrets = await itx.secrets.list();
    const pin = secrets.find((secret) => secret.path === tokenSecretPathOf("x", input.connection))
      ?.urls[0];
    if (!pin)
      throw codedError("INVALID_INPUT", "Set this connection's X client ID and secret first.");
    origin = pin === "https://api.x.com" ? undefined : pin;
  }
  const endpoints = xEndpointsOf(origin);
  const scopes = [
    ...new Set([
      ...DEFAULT_X_SCOPES,
      ...(input.client === "iterate" ? app?.scopes || [] : []),
      ...(input.existing?.scopes || []),
      ...(input.scopes || []),
    ]),
  ];
  const { authorizationUrl, nonce } = await itx.secrets.beginOAuth(
    tokenSecretPathOf("x", input.connection),
    {
      ...endpoints,
      client: input.client === "iterate" ? { platform: "x" } : { project: "x" },
      clientAuth: "client_secret_basic",
      scope: scopes.join(" "),
      next: input.next,
      expectAccount: input.existing?.externalId,
    },
  );
  await scope.storage.put<ConnectionAttempt>(consentAttemptKeyOf("x", input.connection, nonce), {
    client: input.client,
    origin: origin || "",
    until: Date.now() + SECRET_OAUTH_TTL_MS,
    connectToProject: input.connectToProject,
  });
  return { authorizationUrl };
}

/** Record the stable account ID from the token's own profile. */
export async function finishXConnect(
  scope: IntegrationScope,
  connection: string,
  attempt: ConnectionAttempt,
  { grantedScopes }: { grantedScopes: string[] },
) {
  const response = await ownerEgress(
    scope.env,
    scope,
    new Request(xEndpointsOf(attempt.origin).userEndpoint, {
      headers: {
        authorization: `Bearer getSecret("${tokenSecretPathOf("x", connection)}", { field: "accessToken" })`,
      },
    }),
  );
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`X account lookup answered ${response.status}`);
  }
  const { data } = XUserResponse.parse(await response.json());
  const connected = () =>
    appendConnected(scope, {
      provider: "x",
      connection,
      client: attempt.client,
      account: `@${data.username}`,
      externalId: data.id,
      scopes: grantedScopes,
    });
  // Iterate's app routes an X account to ONE project connection, as for Slack and GitHub: a second
  // connection of the same account, here or in another project, is refused, and the token the
  // callback stored for it goes. A person's own account and a project's own client are not routed.
  if (attempt.client !== "iterate" || scope.rootPath !== "/") return { row: await connected() };
  const path = connectionPathOf("x", connection);
  // a reconnect's callback replaced the live token already: only a connection with no row is new
  const isNew = !(await connectionRowOf(scope.env, scope.projectId, path));
  try {
    return {
      row: await routedWhile(
        scope.env,
        {
          provider: "x",
          externalId: data.id,
          projectId: scope.projectId,
          path,
        },
        connected,
      ),
    };
  } catch (error) {
    if (isNew) await deleteTokenSecret(scope, "x", connection);
    throw error;
  }
}
