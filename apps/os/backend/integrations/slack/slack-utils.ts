import { WebClient } from "@slack/web-api";
import { getDb } from "../../db/client.ts";
import { env } from "../../../env.ts";
import { logger } from "../../tag-logger.ts";
import { getSlackAccessTokenForInstallation } from "../../auth/token-utils.ts";

/**
 * Send a notification message to iterate's Slack workspace.
 * This uses the installation ID configured in ITERATE_NOTIFICATION_ESTATE_ID.
 *
 * @param message - The message to send (supports Slack markdown)
 * @param channel - The channel to post to (defaults to "#building")
 */
export async function sendNotificationToIterateSlack(
  message: string,
  channel = "#building",
): Promise<void> {
  const notificationInstallationId = env.ITERATE_NOTIFICATION_ESTATE_ID;

  if (!notificationInstallationId) {
    logger.warn("ITERATE_NOTIFICATION_ESTATE_ID not configured, skipping notification");
    return;
  }

  const db = getDb();

  // Get Slack access token for the notification installation
  const slackAccount = await getSlackAccessTokenForInstallation(db, notificationInstallationId);

  if (!slackAccount) {
    logger.error("Slack access token not found for notification installation", {
      installationId: notificationInstallationId,
    });
    return;
  }

  const slackClient = new WebClient(slackAccount.accessToken);

  const result = await slackClient.chat.postMessage({
    channel,
    text: message,
    unfurl_links: false,
    unfurl_media: false,
  });

  if (!result.ok) {
    logger.error(`Failed to send notification to Slack: ${result.error}`);
  }
}
