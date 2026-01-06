import { Hono } from "hono";
import { getContext } from "hono/context-storage";
import { eq } from "drizzle-orm";
import type { CloudflareEnv } from "../../../env.ts";
import type { Variables } from "../../worker.ts";
import * as schema from "../../db/schema.ts";
import { logger } from "../../tag-logger.ts";
import { verifySlackSignature, isTimestampValid } from "./slack-utils.ts";

export const slackApp = new Hono<{ Bindings: CloudflareEnv; Variables: Variables }>();

slackApp.post("/webhook", async (c) => {
  const {
    env,
    var: { db },
  } = getContext<{ Variables: Variables; Bindings: CloudflareEnv }>();

  const signature = c.req.header("x-slack-signature");
  const timestamp = c.req.header("x-slack-request-timestamp");
  const rawBody = await c.req.text();

  if (!signature || !timestamp) {
    return c.json({ error: "Missing signature headers" }, 401);
  }

  if (!isTimestampValid(timestamp)) {
    return c.json({ error: "Request timestamp too old" }, 401);
  }

  const isValid = await verifySlackSignature(
    env.SLACK_SIGNING_SECRET,
    signature,
    timestamp,
    rawBody,
  );
  if (!isValid) {
    return c.json({ error: "Invalid signature" }, 401);
  }

  const body = JSON.parse(rawBody);

  if (body.type === "url_verification") {
    return c.json({ challenge: body.challenge });
  }

  if (body.event) {
    const eventType = body.event.type;
    const teamId = body.team_id;

    const projectPermission = await db.query.projectAccountPermission.findFirst({
      where: eq(schema.projectAccountPermission.accountId, teamId),
      with: {
        project: true,
      },
    });

    const projectId = projectPermission?.project?.id;

    if (projectId) {
      await db.insert(schema.event).values({
        type: `slack.${eventType}`,
        payload: body,
        projectId,
      });
    } else {
      logger.warn(`No project found for team_id ${teamId}, event not saved`);
    }
  }

  return c.text("ok");
});
