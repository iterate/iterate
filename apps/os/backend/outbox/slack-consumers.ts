import { getDb } from "../db/client.ts";
import * as schema from "../db/schema.ts";
import { logger } from "../tag-logger.ts";
import { env } from "../../env.ts";
import { forwardSlackWebhookToMachine } from "../integrations/slack/slack.ts";
import { outboxClient as cc } from "./client.ts";

export function registerSlackConsumers() {
  cc.registerConsumer({
    name: "handleSlackEvent",
    on: "slack:event",
    handler: async ({ payload }) => {
      const { payload: webhookPayload, teamId, slackEventId } = payload;
      const db = getDb();

      // Dedup check using external_id (Slack's event_id)
      if (slackEventId) {
        const existing = await db.query.event.findFirst({
          where: (e, { eq }) => eq(e.externalId, slackEventId),
        });
        if (existing) {
          logger.debug("[Slack Consumer] Duplicate event, skipping", { slackEventId });
          return "duplicate_event";
        }
      }

      logger.debug("[Slack Consumer] Looking up connection", { teamId });

      // Find connection and the single active machine for its project
      const connection = await db.query.projectConnection.findFirst({
        where: (pc, { eq, and }) => and(eq(pc.provider, "slack"), eq(pc.externalId, teamId)),
        with: {
          project: {
            with: {
              machines: {
                where: (m, { eq }) => eq(m.state, "active"),
                limit: 1,
              },
            },
          },
        },
      });

      const projectId = connection?.projectId;
      if (!projectId) {
        logger.warn("[Slack Consumer] No project for team", { teamId });
        return "no_project";
      }

      // Get the single active machine for this project
      const targetMachine = connection.project?.machines[0] ?? null;

      // Forward to machine if available
      if (targetMachine) {
        logger.debug("[Slack Consumer] Forwarding to machine", { machineId: targetMachine.id });
        const result = await forwardSlackWebhookToMachine(targetMachine, webhookPayload, env);
        if (!result.success) {
          logger.error("[Slack Consumer] Forward failed", { error: result.error });
          throw new Error(`Forward failed: ${result.error}`);
        }
      }

      // Save event with type slack:webhook-received, detailed info in payload
      await db.insert(schema.event).values({
        type: "slack:webhook-received",
        payload: webhookPayload,
        projectId,
        externalId: slackEventId,
      });

      logger.info("[Slack Consumer] Event processed", { teamId, slackEventId });
      return "event_processed";
    },
  });

  cc.registerConsumer({
    name: "handleSlackInteractive",
    on: "slack:interactive",
    handler: async ({ payload }) => {
      const { payload: interactivePayload, teamId } = payload;

      logger.info("[Slack Consumer] Interactive callback received", {
        teamId,
        type: interactivePayload.type,
      });

      // Future: implement interactive callback handling
      // For now, just log and acknowledge
      return "interactive_received";
    },
  });
}
