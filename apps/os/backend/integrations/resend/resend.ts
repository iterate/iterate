/**
 * Resend Email Integration
 *
 * Provides:
 * 1. Email sending (for OTP, notifications, etc.)
 * 2. Webhook receiver for inbound emails
 *
 * ## Setup on Resend Dashboard
 *
 * To receive inbound emails:
 * 1. Go to Resend Dashboard > Receiving
 * 2. Add a custom domain (e.g., mail.iterate.com)
 * 3. Configure DNS records as instructed by Resend
 * 4. Add a webhook endpoint pointing to: https://your-domain/api/integrations/resend/webhook
 * 5. Select "email.received" event type
 * 6. Copy the webhook signing secret and add it to Doppler as RESEND_WEBHOOK_SECRET
 *
 * For sending emails:
 * 1. Verify your sending domain in Resend Dashboard > Domains
 * 2. Copy API key and add to Doppler as RESEND_BOT_API_KEY
 */
import { Hono } from "hono";
import { Resend } from "resend";
import { createMachineStub } from "@iterate-com/sandbox/providers/machine-stub";
import type { CloudflareEnv } from "../../../env.ts";
import { waitUntil } from "../../../env.ts";
import type { Variables } from "../../types.ts";
import * as schema from "../../db/schema.ts";
import { logger } from "../../tag-logger.ts";

export const resendApp = new Hono<{ Bindings: CloudflareEnv; Variables: Variables }>();

/**
 * Create a Resend client from the environment
 */
export function createResendClient(apiKey: string): Resend {
  return new Resend(apiKey);
}

/**
 * Send an email using Resend
 */
export async function sendEmail(
  client: Resend,
  options: {
    from: string;
    to: string | string[];
    subject: string;
    text?: string;
    html?: string;
    replyTo?: string;
  },
): Promise<{ id: string } | { error: string }> {
  const { data, error } = await client.emails.send({
    from: options.from,
    to: Array.isArray(options.to) ? options.to : [options.to],
    subject: options.subject,
    text: options.text ?? "",
    html: options.html,
    replyTo: options.replyTo,
  });

  if (error) {
    logger.error("[Resend] Failed to send email", new Error(error.message));
    return { error: error.message };
  }

  return { id: data!.id };
}

/**
 * Resend webhook payload for email.received event
 */
export interface ResendEmailReceivedPayload {
  type: "email.received";
  created_at: string;
  data: {
    email_id: string;
    created_at: string;
    from: string; // e.g. "John Doe <john@example.com>"
    to: string[];
    cc: string[];
    bcc: string[];
    message_id: string;
    subject: string;
    attachments: Array<{
      id: string;
      filename: string;
      content_type: string;
      content_disposition: string;
      content_id?: string;
    }>;
  };
}

/**
 * Full email content fetched from Resend API
 */
export interface ResendEmailContent {
  id: string;
  from: string;
  to: string[];
  cc: string[] | null;
  bcc: string[] | null;
  subject: string;
  created_at: string;
  text: string;
  html: string;
  headers: Record<string, string>;
}

/**
 * Fetch the full email content (including body) from Resend API.
 * The webhook only includes metadata - we need to call this to get text/html body.
 */
export async function fetchEmailContent(
  client: Resend,
  emailId: string,
): Promise<ResendEmailContent | null> {
  try {
    const { data, error } = await client.emails.receiving.get(emailId);
    if (error) {
      logger.error("[Resend] Failed to fetch email content", new Error(error.message), {
        emailId,
      });
      return null;
    }
    return data as ResendEmailContent;
  } catch (err) {
    logger.error("[Resend] Error fetching email content", err, { emailId });
    return null;
  }
}

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

/**
 * Build a provider-backed fetcher for forwarding webhooks to a machine daemon.
 */
async function buildMachineForwardFetcher(
  machine: typeof schema.machine.$inferSelect,
  env: CloudflareEnv,
): Promise<((input: string | Request | URL, init?: RequestInit) => Promise<Response>) | null> {
  const metadata = machine.metadata as Record<string, unknown> | null;

  try {
    const runtime = await createMachineStub({
      type: machine.type,
      env,
      externalId: machine.externalId,
      metadata: metadata ?? {},
    });
    return await runtime.getFetcher(3000);
  } catch (err) {
    logger.set({ machine: { id: machine.id } });
    logger.error(`[Resend Webhook] Failed to build forward fetcher type=${machine.type}`, err);
    return null;
  }
}

/**
 * Forward an email webhook payload to a machine's daemon.
 */
export async function forwardEmailWebhookToMachine(
  machine: typeof schema.machine.$inferSelect,
  payload: Record<string, unknown>,
  env: CloudflareEnv,
): Promise<{ success: boolean; error?: string }> {
  const fetcher = await buildMachineForwardFetcher(machine, env);
  if (!fetcher) {
    return { success: false, error: "Could not build forward fetcher" };
  }
  try {
    const resp = await fetcher("/api/integrations/email/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) {
      logger.error("[Resend Webhook] Forward failed", {
        machine,
        status: resp.status,
        text: await resp.text(),
      });
      return { success: false, error: `HTTP ${resp.status}` };
    }
    return { success: true };
  } catch (err) {
    logger.error("[Resend Webhook] Forward error", err);
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Verify Resend webhook signature using svix headers
 */
async function verifyResendWebhook(
  client: Resend,
  payload: string,
  headers: {
    id: string | null;
    timestamp: string | null;
    signature: string | null;
  },
  webhookSecret: string,
): Promise<boolean> {
  if (!headers.id || !headers.timestamp || !headers.signature) {
    return false;
  }

  try {
    client.webhooks.verify({
      payload,
      headers: {
        id: headers.id,
        timestamp: headers.timestamp,
        signature: headers.signature,
      },
      webhookSecret,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Resend webhook handler
 *
 * Receives inbound emails and forwards them to the appropriate machine's daemon.
 * Maps sender email -> user -> organizationMembership -> project -> machine
 */
resendApp.post("/webhook", async (c) => {
  const body = await c.req.text();
  const webhookSecret = c.env.RESEND_BOT_WEBHOOK_SECRET;

  // Verify webhook signature if secret is configured
  if (webhookSecret) {
    const client = createResendClient(c.env.RESEND_BOT_API_KEY);
    const isValid = await verifyResendWebhook(
      client,
      body,
      {
        id: c.req.header("svix-id") ?? null,
        timestamp: c.req.header("svix-timestamp") ?? null,
        signature: c.req.header("svix-signature") ?? null,
      },
      webhookSecret,
    );

    if (!isValid) {
      logger.debug("[Resend Webhook] Invalid signature");
      return c.text("Invalid signature", 401);
    }
  }

  let payload: ResendEmailReceivedPayload;
  try {
    payload = JSON.parse(body);
  } catch {
    return c.text("Invalid JSON", 400);
  }

  // Only handle email.received events
  if (payload.type !== "email.received") {
    return c.json({ ok: true, message: "Event type not handled" });
  }

  const emailData = payload.data;
  const senderEmail = parseSenderEmail(emailData.from);
  const resendEmailId = emailData.email_id;

  // Validate inbound email is addressed to this stage
  // Expected format: {stage}@{RESEND_BOT_DOMAIN} or {stage}+{extra}@{RESEND_BOT_DOMAIN}
  const expectedStage = c.env.VITE_APP_STAGE;
  const recipientEmail = emailData.to[0] || "";
  const recipientLocal = parseRecipientLocal(recipientEmail); // e.g., "dev-mmkal" or "dev-mmkal+projectslug"
  const recipientStage = recipientLocal.split("+")[0]; // Strip any +suffix

  // Header to track forwarding and prevent infinite loops
  const FORWARDED_HEADER = "x-iterate-forwarded-from";
  const alreadyForwarded = c.req.header(FORWARDED_HEADER);

  if (recipientStage !== expectedStage) {
    // In production, forward to the correct stage instead of ignoring
    // Only forward if: 1) we're in staging, 2) not already forwarded, 3) target is a dev stage
    const isStaging = expectedStage === "stg";
    const isDevStage = recipientStage.startsWith("dev-");

    if (isStaging && !alreadyForwarded && isDevStage) {
      // Build target URL by replacing hostname in current URL
      // Expected: stg-os.iterate.com -> dev-xxx-os.dev.iterate.com
      const currentUrl = new URL(c.req.url);

      // Replace hostname {stage}-os.dev.iterate.com
      const targetHostname = `${recipientStage}-os.dev.iterate.com`;
      const targetUrl = new URL(currentUrl);
      targetUrl.hostname = targetHostname;

      logger.set({ url: targetUrl.href });
      logger.info(
        `[Resend Webhook] Forwarding email to correct stage expectedStage=${expectedStage} recipientStage=${recipientStage}`,
      );

      try {
        // Forward all headers, adding our forwarded-from header
        const forwardHeaders = new Headers(c.req.raw.headers);
        forwardHeaders.set(FORWARDED_HEADER, expectedStage);

        const forwardResponse = await fetch(targetUrl.href, {
          method: "POST",
          headers: forwardHeaders,
          body,
        });

        // Return the exact response from the target, with an extra header
        const responseHeaders = new Headers(forwardResponse.headers);
        responseHeaders.set("x-iterate-forwarded-to", recipientStage);

        return new Response(forwardResponse.body, {
          status: forwardResponse.status,
          statusText: forwardResponse.statusText,
          headers: responseHeaders,
        });
      } catch (error) {
        logger.error("[Resend Webhook] Failed to forward email", error, {
          url: targetUrl.href,
        });
        return c.json({ ok: false, message: "Failed to forward to correct stage" }, 502);
      }
    }

    logger.info(
      `[Resend Webhook] Email addressed to different stage, ignoring expectedStage=${expectedStage} recipientStage=${recipientStage}`,
    );
    return c.json({ ok: true, message: "Email addressed to different stage" });
  }

  logger.debug("[Resend Webhook] Received email", {
    from: senderEmail,
    to: emailData.to,
    subject: emailData.subject,
    emailId: resendEmailId,
  });

  const db = c.var.db;
  const env = c.env;

  // Process in background for quick response
  waitUntil(
    (async () => {
      try {
        // Dedup check using email_id
        const existing = await db.query.event.findFirst({
          where: (e, { eq: whereEq }) => whereEq(e.externalId, resendEmailId),
        });
        if (existing) {
          logger.debug("[Resend Webhook] Duplicate, skipping", { resendEmailId });
          return;
        }

        // Find user by sender email
        const user = await db.query.user.findFirst({
          where: (u, { eq: whereEq }) => whereEq(u.email, senderEmail.toLowerCase()),
        });

        if (!user) {
          logger.warn(`[Resend Webhook] No user found for sender ${senderEmail}`);
          // Still save the event for debugging
          await db.insert(schema.event).values({
            type: "resend:email-received",
            payload: payload as unknown as Record<string, unknown>,
            externalId: resendEmailId,
          });
          return;
        }

        // Find user's org memberships
        const memberships = await db.query.organizationUserMembership.findMany({
          where: (m, { eq: whereEq }) => whereEq(m.userId, user.id),
          with: {
            organization: {
              with: {
                projects: {
                  with: {
                    machines: {
                      where: (m, { eq: whereEq }) => whereEq(m.state, "active"),
                      limit: 1,
                    },
                  },
                },
              },
            },
          },
        });

        if (memberships.length === 0) {
          logger.set({ user: { id: user.id } });
          logger.warn("[Resend Webhook] No org memberships for user");
          await db.insert(schema.event).values({
            type: "resend:email-received",
            payload: payload as unknown as Record<string, unknown>,
            externalId: resendEmailId,
          });
          return;
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
          logger.set({ user: { id: user.id } });
          logger.warn(
            `[Resend Webhook] No project found for email targetProjectSlug=${targetProjectSlug ?? "none"}`,
          );
          await db.insert(schema.event).values({
            type: "resend:email-received",
            payload: payload as unknown as Record<string, unknown>,
            externalId: resendEmailId,
          });
          return;
        }

        const targetMachine = targetProject.machines[0];

        // Fetch full email content (body) from Resend API
        const resendClient = createResendClient(env.RESEND_BOT_API_KEY);
        const emailContent = await fetchEmailContent(resendClient, resendEmailId);

        // Forward to machine if available
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

        // Save event
        await db.insert(schema.event).values({
          type: "resend:email-received",
          payload: payload as unknown as Record<string, unknown>,
          projectId: targetProject.id,
          externalId: resendEmailId,
        });
      } catch (err) {
        logger.error("[Resend Webhook] Background error", err);
      }
    })(),
  );

  return c.json({ ok: true });
});
