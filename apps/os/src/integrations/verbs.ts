// src/integrations/verbs.ts — connect, finish and disconnect, for either owner: the project facet on a
// project's `/` (project/durable-object.ts) and the account facet on a person's `/users/<id>`
// (account/durable-object.ts) each run these over their own scope and their own `state.integrations`.
// A person connects Google or Cloudflare here (GitHub comes from signing in with it); a project any
// of the four. Waitrose has no consent: either owner connects it with a username and password
// (`connectWaitrose`).
import { codedError } from "iterate/lib";
import { z } from "zod";
import type { IntegrationConnectionRow, IntegrationProvider } from "./contract.ts";
import {
  assertConnectionName,
  attemptKeyOf,
  connectionPathOf,
  type ConnectionAttempt,
  type IntegrationScope,
} from "./connections.ts";
import { connectCloudflare, disconnectCloudflare, finishCloudflareConnect } from "./cloudflare.ts";
import { connectGithub, disconnectGithub } from "./github.ts";
import { connectGoogle, disconnectGoogle, finishGoogleConnect } from "./google.ts";
import { connectSlack, disconnectSlack, finishSlackConnect } from "./slack.ts";
import { disconnectWaitrose } from "./waitrose-connection.ts";

export type ConnectInput = {
  provider: IntegrationProvider;
  connection: string;
  client: "iterate" | "project";
  next?: string;
  /** More permissions than the client's default (Google, Cloudflare, Slack). */
  scopes?: string[];
  /** A GitHub App of the project's own: its public half. */
  appSlug?: string;
  clientId?: string;
};

/** The providers a person connects on their own context. */
const PERSONAL_PROVIDERS: readonly IntegrationProvider[] = ["google", "cloudflare"];

/** CONNECT: where to send a human to consent. Again for a connection that exists asks for more on
 *  the same account: the union of scopes, and the provider must answer for the account the
 *  connection holds (a GitHub App's permissions are the App's: its install page adds repositories). */
export async function connectIntegration(
  scope: IntegrationScope,
  integrations: Record<string, IntegrationConnectionRow>,
  input: ConnectInput,
): Promise<{ authorizationUrl: string }> {
  const request = { ...input, connection: assertConnectionName(input?.connection) };
  if (request.client !== "iterate" && request.client !== "project")
    throw codedError("INVALID_INPUT", 'integrations: client is "iterate" or "project"');
  request.scopes = z.array(z.string().min(1)).optional().parse(request.scopes);
  if (scope.rootPath !== "/" && !PERSONAL_PROVIDERS.includes(request.provider))
    throw codedError(
      "INVALID_INPUT",
      `integrations: a person connects ${PERSONAL_PROVIDERS.join(" or ")} (GitHub by signing in with it); a project connects ${request.provider}`,
    );
  const existing = integrations[connectionPathOf(request.provider, request.connection)];
  if (request.provider === "slack")
    return connectSlack(scope, { ...request, expectAccount: existing?.externalId });
  if (request.provider === "google")
    return connectGoogle(scope, { ...request, expectAccount: existing });
  if (request.provider === "cloudflare")
    return connectCloudflare(scope, { ...request, expectAccount: existing?.externalId });
  if (request.provider === "github") return connectGithub(scope, request);
  if (request.provider === "waitrose")
    throw codedError(
      "INVALID_INPUT",
      "integrations: Waitrose has no consent to send a human to — set /secrets/waitrose-<connection> to { username, password } and call connectWaitrose",
    );
  throw codedError(
    "INVALID_INPUT",
    `integrations: no provider ${JSON.stringify(request.provider)}`,
  );
}

/** The OAuth callback stored a token: finish the connection its attempt names. Again for a
 *  connection already connected, with no attempt left, is a no-op. */
export async function finishIntegrationConnect(
  scope: IntegrationScope,
  integrations: Record<string, IntegrationConnectionRow>,
  input: { provider: "slack" | "google" | "cloudflare"; connection: string },
): Promise<void> {
  const connection = assertConnectionName(input?.connection);
  const key = attemptKeyOf(input.provider, connection);
  const attempt = await scope.storage.get<ConnectionAttempt>(key);
  if (!attempt || attempt.until < Date.now()) {
    if (integrations[connectionPathOf(input.provider, connection)]) return;
    throw new Error("no connect of this connection is in flight — connect again");
  }
  if (input.provider === "slack") await finishSlackConnect(scope, connection, attempt);
  else if (input.provider === "google") await finishGoogleConnect(scope, connection, attempt);
  else await finishCloudflareConnect(scope, connection, attempt);
  await scope.storage.delete(key);
}

/** DISCONNECT: the token revoked where the provider allows, the route and the secret gone, any
 *  connect in flight dropped, `<provider>/disconnected` on the owner's root. */
export async function disconnectIntegration(
  scope: IntegrationScope,
  integrations: Record<string, IntegrationConnectionRow>,
  input: { provider: IntegrationProvider; connection: string },
): Promise<void> {
  const connection = assertConnectionName(input?.connection);
  const row = integrations[connectionPathOf(input.provider, connection)];
  if (input.provider === "slack") await disconnectSlack(scope, connection, row?.client ?? null);
  else if (input.provider === "google")
    await disconnectGoogle(scope, connection, row?.client ?? null);
  else if (input.provider === "cloudflare") await disconnectCloudflare(scope, connection);
  else if (input.provider === "github") await disconnectGithub(scope, connection);
  else if (input.provider === "waitrose") await disconnectWaitrose(scope, connection);
  else
    throw codedError(
      "INVALID_INPUT",
      `integrations: no provider ${JSON.stringify(input.provider)}`,
    );
}
