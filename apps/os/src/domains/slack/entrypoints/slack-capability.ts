import { WorkerEntrypoint } from "cloudflare:workers";
import { readSlackToken } from "~/domains/slack/slack-token.ts";

type SlackCapabilityEnv = Record<string, never>;

type SlackCapabilityProps = {
  projectId?: string;
};

export class SlackCapability extends WorkerEntrypoint<SlackCapabilityEnv, SlackCapabilityProps> {
  /** itx path-call surface: itx.slack.<Slack Web API method path>(body). */
  async call(input: { args: unknown[]; path: string[] }): Promise<unknown> {
    const method = input.path.join(".");
    if (!method) {
      throw new Error("SlackCapability expected a Slack Web API method path.");
    }
    if (input.args.length > 1) {
      throw new Error(`Slack calls are unary; ${method} received ${input.args.length} args.`);
    }
    return await this.request({
      body: input.args[0] as Record<string, unknown> | undefined,
      method,
    });
  }

  async request(input: { body?: Record<string, unknown>; method: string }) {
    const token = await this.readToken();
    if (!token) {
      throw new Error(
        "SlackCapability requires a connected Slack account (Secret slack/default/access-token) or a deployment bot token.",
      );
    }

    return await callSlackWebApi({
      body: input.body ?? {},
      method: input.method,
      token,
    });
  }

  private async readToken() {
    if (!this.ctx.props.projectId) return undefined;
    return await readSlackToken({ projectId: this.ctx.props.projectId });
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
