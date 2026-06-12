// The Slack bot token, post-clean-cut: a journaled Secret at
// /secrets/slack/{account}/access-token (set by the connect choreography),
// with the deployment-level env token as the first-party dev fallback.
// Callers are platform code inside the Slack pipeline (the 👀 ack, the
// slack-agent's Web API side effects) — the reveal is audited on the
// secret's own journal.

import { env } from "cloudflare:workers";
import { providedSecretSlug } from "~/domains/integrations/definition.ts";
import { DEFAULT_INTEGRATION_ACCOUNT } from "~/domains/integrations/integration-events.ts";
import { SLACK_ACCESS_TOKEN_SECRET_NAME } from "~/domains/integrations/providers/slack.ts";
import { revealJournaledSecretForPlatformUse } from "~/domains/secrets/secret-streams.ts";

type SlackTokenEnv = {
  APP_CONFIG_SLACK_BOT_TOKEN?: string;
  SLACK_BOT_TOKEN?: string;
};

/** Thread streams live at /agents/slack/{account}/{channel}/ts-{ts}; the
 * slack-agent host recovers its workspace ACCOUNT from its own path. */
export function slackAccountFromStreamPath(streamPath: string): string {
  const segments = streamPath.split("/").filter(Boolean);
  if (segments[0] === "agents" && segments[1] === "slack" && segments.length >= 5) {
    return segments[2]!;
  }
  return DEFAULT_INTEGRATION_ACCOUNT;
}

export async function readSlackToken(input: {
  projectId: string;
  account?: string;
}): Promise<string | undefined> {
  try {
    return await revealJournaledSecretForPlatformUse({
      projectId: input.projectId,
      slug: providedSecretSlug({
        integration: "slack",
        account: input.account ?? DEFAULT_INTEGRATION_ACCOUNT,
        name: SLACK_ACCESS_TOKEN_SECRET_NAME,
      }),
      usedBy: "slack-pipeline",
    });
  } catch {
    const tokenEnv = env as unknown as SlackTokenEnv;
    return tokenEnv.SLACK_BOT_TOKEN ?? tokenEnv.APP_CONFIG_SLACK_BOT_TOKEN;
  }
}
