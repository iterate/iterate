import { env } from "../../../env.ts";
import { getDb } from "../../db/client.ts";
import * as schema from "../../db/schema.ts";
import { logger } from "../../tag-logger.ts";
import { forwardSlackInteractiveToMachine, forwardSlackWebhookToMachine } from "./slack.ts";

function getSlackTeamId(payload: Record<string, unknown>): string | undefined {
  return (
    (payload.team_id as string | undefined) ||
    ((payload.team as Record<string, unknown> | undefined)?.id as string | undefined) ||
    ((payload.event as Record<string, unknown> | undefined)?.team as string | undefined)
  );
}

function getSlackEventId(payload: Record<string, unknown>): string | undefined {
  return payload.event_id as string | undefined;
}

async function getSlackTargetMachine(db: ReturnType<typeof getDb>, teamId: string) {
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

  return {
    projectId: connection?.projectId,
    machine: connection?.project?.machines?.[0] ?? null,
  };
}

export async function handleSlackWebhookEvent(event: Record<string, unknown>): Promise<void> {
  const teamId = getSlackTeamId(event);
  if (!teamId) {
    logger.warn("[Slack Webhook] No team_id in payload");
    return;
  }

  const slackEventId = getSlackEventId(event);
  const db = getDb();

  if (slackEventId) {
    const existing = await db.query.event.findFirst({
      where: (e, { eq }) => eq(e.externalId, slackEventId),
    });
    if (existing) {
      logger.debug("[Slack Webhook] Duplicate, skipping", { slackEventId });
      return;
    }
  }

  logger.debug("[Slack Webhook] Looking up connection", { teamId });
  const { projectId, machine } = await getSlackTargetMachine(db, teamId);

  if (!projectId) {
    logger.warn("[Slack Webhook] No project for team", { teamId });
    return;
  }

  if (machine) {
    logger.debug("[Slack Webhook] Forwarding to machine", { machineId: machine.id });
    await forwardSlackWebhookToMachine(machine, event, env);
  }

  await db.insert(schema.event).values({
    type: "slack:webhook-received",
    payload: event,
    projectId,
    externalId: slackEventId,
  });
}

export async function handleSlackInteractiveEvent(event: Record<string, unknown>): Promise<void> {
  const teamId = getSlackTeamId(event);
  if (!teamId) {
    logger.warn("[Slack Interactive] No team_id in payload");
    return;
  }

  const db = getDb();
  const { projectId, machine } = await getSlackTargetMachine(db, teamId);

  if (!projectId) {
    logger.warn("[Slack Interactive] No project for team", { teamId });
    return;
  }

  if (machine) {
    logger.debug("[Slack Interactive] Forwarding to machine", { machineId: machine.id });
    await forwardSlackInteractiveToMachine(machine, event, env);
  }

  await db.insert(schema.event).values({
    type: "slack:interactive-received",
    payload: event,
    projectId,
  });
}
