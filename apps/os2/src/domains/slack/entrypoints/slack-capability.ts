import { WorkerEntrypoint } from "cloudflare:workers";
import type { ExecuteCodemodeFunctionCallInput } from "@iterate-com/shared/stream-processors/codemode/implementation";

type SlackCapabilityEnv = {
  APP_CONFIG_SLACK_BOT_TOKEN?: string;
  SLACK_BOT_TOKEN?: string;
};

export class SlackCapability extends WorkerEntrypoint<SlackCapabilityEnv> {
  async executeCodemodeFunctionCall(input: ExecuteCodemodeFunctionCallInput) {
    // Slack's Web API is already method-path based (`chat.postMessage`,
    // `conversations.list`, ...), so this capability intentionally keeps the
    // provider glue generic: codemode path segments become the Slack method
    // name, and the single codemode arg becomes the JSON request body.
    const method = input.functionPath.join(".");
    if (!method) {
      throw new Error("SlackCapability expected a Slack Web API method path.");
    }
    if (input.args.length > 1) {
      throw new Error(
        `Slack codemode calls are unary; ${input.path.join(".")} received ${input.args.length} args.`,
      );
    }

    const token = this.env.SLACK_BOT_TOKEN ?? this.env.APP_CONFIG_SLACK_BOT_TOKEN;
    if (!token) {
      throw new Error("SlackCapability requires SLACK_BOT_TOKEN or APP_CONFIG_SLACK_BOT_TOKEN.");
    }

    const [body] = input.args as [Record<string, unknown> | undefined];
    return await callSlackWebApi({
      body: body ?? {},
      method,
      token,
    });
  }
}

export async function callSlackWebApi(input: {
  body: Record<string, unknown>;
  method: string;
  token: string;
}) {
  const response = await fetch(`https://slack.com/api/${input.method}`, {
    body: JSON.stringify(input.body),
    headers: {
      authorization: `Bearer ${input.token}`,
      "content-type": "application/json; charset=utf-8",
    },
    method: "POST",
  });
  const result = (await response.json()) as { error?: string; ok?: boolean } & Record<
    string,
    unknown
  >;
  if (!response.ok || result.ok === false) {
    const error = typeof result.error === "string" ? result.error : `HTTP ${response.status}`;
    throw new Error(`Slack Web API ${input.method} failed: ${error}`);
  }
  return result;
}
