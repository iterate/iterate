import { WorkerEntrypoint } from "cloudflare:workers";
import type { ExecuteCodemodeFunctionCallInput } from "@iterate-com/shared/stream-processors/codemode/implementation";
import { createD1Client } from "sqlfu";
import { getProjectSecret } from "~/domains/secrets/secrets-store.ts";

type SlackCapabilityEnv = {
  APP_CONFIG_SLACK_BOT_TOKEN?: string;
  DB?: D1Database;
  SLACK_BOT_TOKEN?: string;
};

type SlackCapabilityProps = {
  projectId?: string;
};

export class SlackCapability extends WorkerEntrypoint<SlackCapabilityEnv, SlackCapabilityProps> {
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

    const token = await this.readToken();
    if (!token) {
      throw new Error(
        "SlackCapability requires a project slack.access_token Secret or SLACK_BOT_TOKEN/APP_CONFIG_SLACK_BOT_TOKEN.",
      );
    }

    const [body] = input.args as [Record<string, unknown> | undefined];
    return await callSlackWebApi({
      body: body ?? {},
      method,
      token,
    });
  }

  private async readToken() {
    if (this.env.DB && this.ctx.props.projectId) {
      const secret = await getProjectSecret(createD1Client(this.env.DB), {
        key: "slack.access_token",
        projectId: this.ctx.props.projectId,
      });
      if (secret) return secret.material;
    }

    return this.env.SLACK_BOT_TOKEN ?? this.env.APP_CONFIG_SLACK_BOT_TOKEN;
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
