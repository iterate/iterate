import { env } from "../../../env.ts";
import { getDb } from "../../db/client.ts";
import * as schema from "../../db/schema.ts";
import { logger } from "../../tag-logger.ts";
import {
  createResendClient,
  fetchEmailContent,
  forwardEmailWebhookToMachine,
  parseRecipientLocal,
  parseSenderEmail,
  type ResendEmailReceivedPayload,
} from "./resend.ts";

export async function handleResendEmailReceived(
  payload: ResendEmailReceivedPayload,
): Promise<void> {
  const emailData = payload.data;
  const senderEmail = parseSenderEmail(emailData.from);
  const resendEmailId = emailData.email_id;
  const db = getDb();

  const existing = await db.query.event.findFirst({
    where: (e, { eq }) => eq(e.externalId, resendEmailId),
  });
  if (existing) {
    logger.debug("[Resend Webhook] Duplicate, skipping", { resendEmailId });
    return;
  }

  const user = await db.query.user.findFirst({
    where: (u, { eq }) => eq(u.email, senderEmail.toLowerCase()),
  });

  if (!user) {
    logger.warn("[Resend Webhook] No user found for sender", { senderEmail });
    await db.insert(schema.event).values({
      type: "resend:email-received",
      payload: payload as unknown as Record<string, unknown>,
      externalId: resendEmailId,
    });
    return;
  }

  const memberships = await db.query.organizationUserMembership.findMany({
    where: (m, { eq }) => eq(m.userId, user.id),
    with: {
      organization: {
        with: {
          projects: {
            with: {
              machines: {
                where: (m, { eq }) => eq(m.state, "active"),
                limit: 1,
              },
            },
          },
        },
      },
    },
  });

  if (memberships.length === 0) {
    logger.warn("[Resend Webhook] No org memberships for user", { userId: user.id });
    await db.insert(schema.event).values({
      type: "resend:email-received",
      payload: payload as unknown as Record<string, unknown>,
      externalId: resendEmailId,
    });
    return;
  }

  const recipientLocal = emailData.to[0] ? parseRecipientLocal(emailData.to[0]) : "";
  const projectSlugMatch = recipientLocal.match(/\+([^@]+)$/);
  const targetProjectSlug = projectSlugMatch ? projectSlugMatch[1] : null;

  let targetProject:
    | (typeof schema.project.$inferSelect & {
        machines: (typeof schema.machine.$inferSelect)[];
      })
    | null = null;

  for (const membership of memberships) {
    const org = membership.organization;
    for (const project of org.projects) {
      if (targetProjectSlug && project.slug === targetProjectSlug) {
        targetProject = project;
        break;
      }
      if (!targetProjectSlug && project.machines.length > 0 && !targetProject) {
        targetProject = project;
      }
    }
    if (targetProject) break;
  }

  if (!targetProject) {
    logger.warn("[Resend Webhook] No project found for email", {
      userId: user.id,
      targetProjectSlug,
    });
    await db.insert(schema.event).values({
      type: "resend:email-received",
      payload: payload as unknown as Record<string, unknown>,
      externalId: resendEmailId,
    });
    return;
  }

  const targetMachine = targetProject.machines[0];

  const resendClient = createResendClient(env.RESEND_BOT_API_KEY);
  const emailContent = await fetchEmailContent(resendClient, resendEmailId);

  if (targetMachine) {
    logger.debug("[Resend Webhook] Forwarding to machine", { machineId: targetMachine.id });
    await forwardEmailWebhookToMachine(
      targetMachine,
      {
        ...payload,
        _iterate: {
          userId: user.id,
          projectId: targetProject.id,
          emailBody: emailContent
            ? {
                text: emailContent.text,
                html: emailContent.html,
              }
            : null,
        },
      },
      env,
    );
  }

  await db.insert(schema.event).values({
    type: "resend:email-received",
    payload: payload as unknown as Record<string, unknown>,
    projectId: targetProject.id,
    externalId: resendEmailId,
  });
}
