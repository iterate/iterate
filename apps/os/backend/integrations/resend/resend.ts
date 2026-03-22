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
import { z } from "zod";
import type { CloudflareEnv } from "../../../env.ts";
import type { Variables } from "../../types.ts";
import * as schema from "../../db/schema.ts";
import { ResendWebhookReceivedEventPayload } from "../../events.ts";
import { outboxClient } from "../../outbox/client.ts";
import { logger } from "../../tag-logger.ts";
import { buildMachineFetcher } from "../../services/machine-readiness-probe.ts";
import { parseSenderEmail } from "../../email/email-routing.ts";

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
 * Build a provider-backed fetcher for forwarding webhooks to a machine daemon.
 */
async function buildMachineForwardFetcher(
  machine: typeof schema.machine.$inferSelect,
  env: CloudflareEnv,
) {
  return buildMachineFetcher(machine, env, "Resend Webhook");
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
 * Receives inbound emails and stores them as outbox events.
 * Downstream consumers resolve routing, provision resources if needed, and forward to daemons.
 */
resendApp.post("/webhook", async (c) => {
  const body = await c.req.text();
  const webhookSecret = c.env.RESEND_BOT_WEBHOOK_SECRET;

  let payload: ResendWebhookReceivedEventPayload;
  try {
    payload = ResendWebhookReceivedEventPayload.parse(JSON.parse(body));
  } catch (error) {
    logger.warn(
      error instanceof z.ZodError
        ? `[Resend Webhook] Invalid JSON: ${z.prettifyError(error)}`
        : `[Resend Webhook] Invalid JSON: ${String(error)}`,
    );
    return c.text("Invalid JSON", 400);
  }

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

  // Only handle email.received events
  if (payload.type !== "email.received") {
    return c.json({ ok: true, message: "Event type not handled" });
  }

  const emailData = payload.data;
  const senderEmail = parseSenderEmail(emailData.from);
  const resendEmailId = emailData.email_id;

  logger.debug("[Resend Webhook] Received email", {
    from: senderEmail,
    to: emailData.to,
    subject: emailData.subject,
    emailId: resendEmailId,
  });

  const result = await outboxClient.send(c.var.db, {
    name: "resend:webhook-received",
    payload,
    deduplicationKey: resendEmailId,
  });

  return c.json({ ok: true, result });
});
