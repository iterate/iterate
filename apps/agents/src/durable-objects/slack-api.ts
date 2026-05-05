import { DurableObject } from "cloudflare:workers";
import { parseAppConfigFromEnv } from "@iterate-com/shared/apps/config";
import { WebClient } from "@slack/web-api";
import { AppConfig } from "~/app.ts";
import type { CloudflareEnv } from "~/lib/worker-env.d.ts";

interface GetTypesPayload {
  namespace?: string;
}

interface GetTypesResponse {
  types: string;
}

interface CallToolPayload {
  name: string;
  args: unknown[];
}

/**
 * POC SDK-backed provider: keep Slack auth and SDK details inside the Worker,
 * while codemode sees one generic `apiCall` tool.
 */
export class SlackApi extends DurableObject<CloudflareEnv> {
  #client: WebClient;

  constructor(state: DurableObjectState, env: CloudflareEnv) {
    super(state, env);
    const config = parseAppConfigFromEnv({
      configSchema: AppConfig,
      prefix: "APP_CONFIG_",
      env,
    });
    const token = config.slackBotToken?.exposeSecret();
    if (!token) {
      throw new Error("APP_CONFIG_SLACK_BOT_TOKEN is required to use SlackApi");
    }
    this.#client = new WebClient(token);
  }

  async getTypes(payload: GetTypesPayload | null): Promise<GetTypesResponse> {
    const namespace = payload?.namespace ?? "slack";
    return {
      types: [
        "/**",
        " * Slack SDK-backed tool provider.",
        " *",
        " * This provider intentionally does not print the full Slack SDK type surface.",
        " * Use Slack Web API method names from https://api.slack.com/methods and",
        " * the @slack/web-api WebClient docs/types for each method's option shape.",
        " *",
        ' * Example: await slack.apiCall("chat.postMessage", { channel: "C123", text: "hello" })',
        " */",
        `declare const ${namespace}: {`,
        "  /**",
        "   * Pass through to @slack/web-api WebClient.apiCall(method, options).",
        "   * The bot token is supplied by the Durable Object; do not pass token in options.",
        "   */",
        "  apiCall(method: string, options?: Record<string, unknown>): Promise<unknown>;",
        "};",
      ].join("\n"),
    };
  }

  async callTool(payload: CallToolPayload): Promise<unknown> {
    if (payload.name !== "apiCall") {
      throw new Error(`SlackApi only exposes apiCall, got "${payload.name}"`);
    }
    const { method, options } = extractApiCallArgs(payload.args);
    return await this.#client.apiCall(method, options);
  }
}

function extractApiCallArgs(args: unknown[]): {
  method: string;
  options: Record<string, unknown>;
} {
  if (args.length === 0) {
    throw new Error("slack.apiCall requires a Slack Web API method name");
  }
  if (args.length > 2) {
    throw new Error(`slack.apiCall expects method and optional options, got ${args.length} args`);
  }
  const method = args[0];
  if (typeof method !== "string" || method.trim().length === 0) {
    throw new Error("slack.apiCall first argument must be a non-empty method string");
  }
  const rawOptions = args[1] ?? {};
  if (typeof rawOptions !== "object" || rawOptions === null || Array.isArray(rawOptions)) {
    throw new Error("slack.apiCall options must be a plain object");
  }
  const options = rawOptions as Record<string, unknown>;
  if ("token" in options) {
    throw new Error("slack.apiCall options must not include token; SlackApi supplies it");
  }
  return { method: method.trim(), options };
}
