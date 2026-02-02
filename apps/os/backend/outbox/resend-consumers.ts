import { getDb } from "../db/client.ts";
import * as schema from "../db/schema.ts";
import { logger } from "../tag-logger.ts";
import { env } from "../../env.ts";
import {
  forwardEmailWebhookToMachine,
  createResendClient,
  fetchEmailContent,
  type ResendEmailReceivedPayload,
} from "../integrations/resend/resend.ts";
import { outboxClient as cc } from "./client.ts";

/**
 * Parse sender email from "Name <email@domain.com>" format
 */
function parseSenderEmail(from: string): string {
  const match = from.match(/<([^>]+)>/);
  return match ? match[1] : from;
}

/**
 * Parse recipient email to extract the local part (before @)
 * e.g., "agent+projectslug@mail.iterate.com" -> "agent+projectslug"
 */
function parseRecipientLocal(to: string): string {
  const email = to.includes("<") ? parseSenderEmail(to) : to;
  return email.split("@")[0];
}

export function registerResendConsumers() {
  cc.registerConsumer({
    name: "handleResendEmailReceived",
    on: "resend:email.received",
    handler: async ({ payload }) => {
      const { payload: webhookPayload, resendEmailId } = payload;
      const emailPayload = webhookPayload as unknown as ResendEmailReceivedPayload;
      const db = getDb();

      // Dedup check using email_id
      const existing = await db.query.event.findFirst({
        where: (e, { eq }) => eq(e.externalId, resendEmailId),
      });
      if (existing) {
        logger.debug("[Resend Consumer] Duplicate, skipping", { resendEmailId });
        return "duplicate_event";
      }

      const emailData = emailPayload.data;
      const senderEmail = parseSenderEmail(emailData.from);

      // Find user by sender email
      const user = await db.query.user.findFirst({
        where: (u, { eq }) => eq(u.email, senderEmail.toLowerCase()),
      });

      if (!user) {
        logger.warn("[Resend Consumer] No user found for sender", { senderEmail });
        // Still save the event for debugging
        await db.insert(schema.event).values({
          type: "resend:email-received",
          payload: webhookPayload,
          externalId: resendEmailId,
        });
        return "no_user";
      }

      // Find user's org memberships
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
        logger.warn("[Resend Consumer] No org memberships for user", { userId: user.id });
        await db.insert(schema.event).values({
          type: "resend:email-received",
          payload: webhookPayload,
          externalId: resendEmailId,
        });
        return "no_org";
      }

      // Try to find a project from recipient address
      // Format: agent+{projectslug}@domain.com or just use first project
      const recipientLocal = emailData.to[0] ? parseRecipientLocal(emailData.to[0]) : "";
      const projectSlugMatch = recipientLocal.match(/\+([^@]+)$/);
      const targetProjectSlug = projectSlugMatch ? projectSlugMatch[1] : null;

      let targetProject:
        | (typeof schema.project.$inferSelect & {
            machines: (typeof schema.machine.$inferSelect)[];
          })
        | null = null;

      // Search across all user's orgs for the matching project
      for (const membership of memberships) {
        const org = membership.organization;
        for (const project of org.projects) {
          if (targetProjectSlug && project.slug === targetProjectSlug) {
            targetProject = project;
            break;
          }
          // Default to first project with an active machine if no slug specified
          if (!targetProjectSlug && project.machines.length > 0 && !targetProject) {
            targetProject = project;
          }
        }
        if (targetProject) break;
      }

      if (!targetProject) {
        logger.warn("[Resend Consumer] No project found for email", {
          userId: user.id,
          targetProjectSlug,
        });
        await db.insert(schema.event).values({
          type: "resend:email-received",
          payload: webhookPayload,
          externalId: resendEmailId,
        });
        return "no_project";
      }

      const targetMachine = targetProject.machines[0];

      // Fetch full email content (body) from Resend API
      const resendClient = createResendClient(env.RESEND_BOT_API_KEY);
      const emailContent = await fetchEmailContent(resendClient, resendEmailId);

      // Forward to machine if available
      if (targetMachine) {
        logger.debug("[Resend Consumer] Forwarding to machine", { machineId: targetMachine.id });
        const result = await forwardEmailWebhookToMachine(
          targetMachine,
          {
            ...webhookPayload,
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
        if (!result.success) {
          logger.error("[Resend Consumer] Forward failed", { error: result.error });
          throw new Error(`Forward failed: ${result.error}`);
        }
      }

      // Save event
      await db.insert(schema.event).values({
        type: "resend:email-received",
        payload: webhookPayload,
        projectId: targetProject.id,
        externalId: resendEmailId,
      });

      logger.info("[Resend Consumer] Email processed", { resendEmailId, userId: user.id });
      return "email_processed";
    },
  });
}
