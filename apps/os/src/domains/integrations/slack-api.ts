// Slack Web API access for itx.
//
// Each named Slack connection's bot token lives in an itx secret Durable
// Object (`/secrets/integrations/slack/{connection}/bot-token`). Calls go
// through the project egress door with a `getSecret(path)`
// placeholder in the authorization header, so token material never leaves the
// secret DO's substitution pipeline and every outbound attempt lands on the
// secret's audit trail. There is NO fallback token: a missing secret (typo'd
// connection name, disconnected workspace) fails loudly instead of silently
// posting with someone else's credential.

import { itxEnv } from "../../env.ts";
import { projectStub } from "../projects/egress.ts";
import { slackBotTokenSecretPath } from "./utils.ts";

type SlackWebApiResult = { error?: string; ok?: boolean } & Record<string, unknown>;

/**
 * Slack Web API call authorized by one named connection's stored bot token,
 * without ever reading the token material: the request carries a secret
 * reference placeholder and traverses the project egress door, which
 * substitutes it in the secret Durable Object.
 */
export async function callProjectSlackWebApi(input: {
  body: Record<string, unknown>;
  connection: string;
  method: string;
  projectId: string;
}): Promise<SlackWebApiResult> {
  const placeholder = `getSecret("${slackBotTokenSecretPath(input.connection)}")`;
  const request = new Request(`https://slack.com/api/${input.method}`, {
    body: JSON.stringify(input.body),
    headers: {
      authorization: `Bearer ${placeholder}`,
      "content-type": "application/json; charset=utf-8",
    },
    method: "POST",
  });
  const response = await projectStub(itxEnv.PROJECT, input.projectId).fetch(request);
  if (response.status === 404 || response.status === 400) {
    // secret_not_found / secret_reference errors from the secret pipeline —
    // not a Slack response. Name the connection so the failure is actionable.
    const errorBody = (await response
      .clone()
      .json()
      .catch(() => null)) as { error?: string } | null;
    if (errorBody?.error?.startsWith("secret_")) {
      throw new Error(
        `Slack Web API ${input.method} failed: connection "${input.connection}" has no usable bot token secret (${errorBody.error}). Use itx.integrations.list() to see connections.`,
      );
    }
  }
  return await parseSlackWebApiResponse(response, input.method);
}

async function parseSlackWebApiResponse(
  response: Response,
  method: string,
): Promise<SlackWebApiResult> {
  const result = (await response.json().catch(() => null)) as SlackWebApiResult | null;
  if (result === null) {
    throw new Error(`Slack Web API ${method} failed: HTTP ${response.status} (non-JSON body)`);
  }
  if (!response.ok || result.ok === false) {
    const error = typeof result.error === "string" ? result.error : `HTTP ${response.status}`;
    throw new Error(`Slack Web API ${method} failed: ${error}`);
  }
  return result;
}
