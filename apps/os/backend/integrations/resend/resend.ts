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
import type { CloudflareEnv } from "../../../env.ts";
import type { Variables } from "../../types.ts";
import { getDb } from "../../db/client.ts";
import * as schema from "../../db/schema.ts";
import { outboxClient } from "../../outbox/client.ts";
import { logger } from "../../tag-logger.ts";
import { createMachineProvider } from "../../providers/index.ts";

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
    logger.error("[Resend] Failed to send email", { error });
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
      logger.error("[Resend] Failed to fetch email content", { emailId, error });
      return null;
    }
    return data as ResendEmailContent;
  } catch (err) {
    logger.error("[Resend] Error fetching email content", { emailId, error: err });
    return null;
  }
}

/**
 * Parse sender email from "Name <email@domain.com>" format
 */
export function parseSenderEmail(from: string): string {
  const match = from.match(/<([^>]+)>/);
  return match ? match[1] : from;
}

/**
 * Parse recipient email to extract the local part (before @)
 * e.g., "agent+projectslug@mail.iterate.com" -> "agent+projectslug"
 */
export function parseRecipientLocal(to: string): string {
  const email = to.includes("<") ? parseSenderEmail(to) : to;
  return email.split("@")[0];
}

/**
 * Build URL to forward webhooks to a machine's daemon.
 */
async function buildMachineForwardUrl(
  machine: typeof schema.machine.$inferSelect,
  path: string,
  env: CloudflareEnv,
): Promise<string | null> {
  const metadata = machine.metadata as Record<string, unknown> | null;

  try {
    const provider = await createMachineProvider({
      type: machine.type,
      env,
      externalId: machine.externalId,
      metadata: metadata ?? {},
      buildProxyUrl: () => "",
    });
    return `${provider.previewUrl}${path}`;
  } catch (err) {
    logger.warn("[Resend Webhook] Failed to build forward URL", {
      machineId: machine.id,
      type: machine.type,
      error: err instanceof Error ? err.message : String(err),
    });
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
  const targetUrl = await buildMachineForwardUrl(machine, "/api/integrations/email/webhook", env);
  if (!targetUrl) {
    return { success: false, error: "Could not build forward URL" };
  }
  try {
    const resp = await fetch(targetUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) {
      logger.error("[Resend Webhook] Forward failed", {
        machine,
        targetUrl,
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

      logger.info("[Resend Webhook] Forwarding email to correct stage", {
        expectedStage,
        recipientStage,
        targetUrl: targetUrl.href,
      });

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
        logger.error("[Resend Webhook] Failed to forward email", {
          error,
          targetUrl: targetUrl.href,
        });
        return c.json({ ok: false, message: "Failed to forward to correct stage" }, 502);
      }
    }

    logger.info("[Resend Webhook] Email addressed to different stage, ignoring", {
      expectedStage,
      recipientStage,
      recipientEmail,
      alreadyForwarded: alreadyForwarded ?? null,
    });
    return c.json({ ok: true, message: "Email addressed to different stage" });
  }

  logger.debug("[Resend Webhook] Received email", {
    from: senderEmail,
    to: emailData.to,
    subject: emailData.subject,
    emailId: resendEmailId,
  });

  await outboxClient.sendTx(getDb(), "resend:email.received", async (_tx) => ({
    payload: { event: payload },
  }));

  return c.json({ ok: true });
});
