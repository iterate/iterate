import { WebClient } from "@slack/web-api";
import { env } from "../../../env.ts";

export async function slackAPI() {
  return new WebClient(env.SLACK_PROXY_BOT_TOKEN);
}

export type SlackAPI = ReturnType<typeof slackAPI>;
