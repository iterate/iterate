// Slack Web API access for itx.
//
// The project's Slack bot token lives in an engine secret Durable Object
// (`/secrets/integrations/slack/bot-token`). Calls go through the project
// egress door with a `getSecret({ path: ... })` placeholder in the
// authorization header, so token material never leaves the secret DO's
// substitution pipeline and every outbound attempt lands on the secret's
// audit trail. When the project has no connected workspace, the deployment
// `slackBotToken` config (if set) is the fallback, matching legacy behavior.

import { itxEnv } from "../../env.ts";
import { projectStub } from "../projects/egress.ts";
import { SLACK_BOT_TOKEN_SECRET_PATH } from "./utils.ts";
import { parseConfig } from "~/config.ts";

export type SlackWebApiResult = { error?: string; ok?: boolean } & Record<string, unknown>;

/** Direct Slack Web API call with a literal token (OAuth exchange, fallback token). */
export async function callSlackWebApi(input: {
  body: Record<string, unknown>;
  method: string;
  token: string;
}): Promise<SlackWebApiResult> {
  const response = await fetch(`https://slack.com/api/${input.method}`, {
    body: JSON.stringify(input.body),
    headers: {
      authorization: `Bearer ${input.token}`,
      "content-type": "application/json; charset=utf-8",
    },
    method: "POST",
  });
  return await parseSlackWebApiResponse(response, input.method);
}

/**
 * Slack Web API call authorized by the project's stored bot token, without
 * ever reading the token material: the request carries a secret reference
 * placeholder and traverses the project egress door, which substitutes it in
 * the secret Durable Object. Falls back to the deployment `slackBotToken`
 * config when the project has no stored token.
 */
export async function callProjectSlackWebApi(input: {
  body: Record<string, unknown>;
  method: string;
  projectId: string;
}): Promise<SlackWebApiResult> {
  const placeholder = `getSecret({ path: "${SLACK_BOT_TOKEN_SECRET_PATH}" })`;
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
    // not a Slack response. Fall back to the deployment-wide bot token.
    const errorBody = (await response
      .clone()
      .json()
      .catch(() => null)) as { error?: string } | null;
    if (errorBody?.error?.startsWith("secret_")) {
      const fallbackToken = readFallbackSlackBotToken();
      if (fallbackToken === null) {
        throw new Error(
          `Slack Web API ${input.method} failed: no project Slack bot token secret and no slackBotToken config fallback (${errorBody.error}).`,
        );
      }
      return await callSlackWebApi({
        body: input.body,
        method: input.method,
        token: fallbackToken,
      });
    }
  }
  return await parseSlackWebApiResponse(response, input.method);
}

function readFallbackSlackBotToken(): string | null {
  try {
    const token = parseConfig(itxEnv).slackBotToken?.exposeSecret();
    return token && token.trim() !== "" ? token : null;
  } catch {
    return null;
  }
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
