// The Slack bot token, post-clean-cut: a journaled Secret at
// /secrets/slack/{account}/access-token (set by the connect choreography),
// with the deployment-level env token as the first-party dev fallback.
// Callers are platform code inside the Slack pipeline (the 👀 ack, the
// slack-agent's Web API side effects) — the reveal is audited on the
// secret's own journal.

import { env } from "cloudflare:workers";
import { providedSecretSlug } from "~/domains/integrations/definition.ts";
import { DEFAULT_INTEGRATION_ACCOUNT } from "~/domains/integrations/integration-events.ts";
import {
  AmbiguousIntegrationAccountError,
  resolveImplicitAccount,
} from "~/domains/integrations/durable-objects/integration-durable-object.ts";
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
  // Pipeline callers pass the routed account explicitly (the envelope stamp,
  // the agent's stream path). A BARE call (itx.slack) resolves like every
  // other bare integration address: the sole connected workspace, or a loud
  // ambiguity error when there are several — never "whichever token reveals
  // first", which would authenticate as an arbitrary workspace.
  const account =
    input.account ??
    (await resolveImplicitAccount({ projectId: input.projectId, integration: "slack" }).catch(
      (error) => {
        if (error instanceof AmbiguousIntegrationAccountError) throw error;
        // Catalog unavailable (fully-local dev) — the unnamed account.
        return DEFAULT_INTEGRATION_ACCOUNT;
      },
    ));
  try {
    return await revealJournaledSecretForPlatformUse({
      projectId: input.projectId,
      slug: providedSecretSlug({
        integration: "slack",
        account,
        name: SLACK_ACCESS_TOKEN_SECRET_NAME,
      }),
      usedBy: "slack-pipeline",
    });
  } catch {
    // No journaled token for that account. The deployment-level env token is
    // the first-party dev fallback, but it is the PLATFORM's own Slack bot —
    // it must never stand in for a connected customer workspace. So it only
    // backstops the DEFAULT (unnamed) account, which is the local-dev /
    // single-first-party-workspace shape. A resolved or explicitly-routed
    // NAMED workspace account whose token can't be revealed fails CLOSED
    // (undefined) rather than silently acting as the platform bot.
    if (account !== DEFAULT_INTEGRATION_ACCOUNT) return undefined;
  }
  const tokenEnv = env as unknown as SlackTokenEnv;
  return tokenEnv.SLACK_BOT_TOKEN ?? tokenEnv.APP_CONFIG_SLACK_BOT_TOKEN;
}
