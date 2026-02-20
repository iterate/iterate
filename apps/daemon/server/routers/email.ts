/**
 * Email Router
 *
 * Handles incoming emails forwarded from the OS backend (Resend webhooks).
 * One agent per email thread, keyed by normalized subject line.
 *
 * Flow:
 *   1. OS worker receives Resend email.received webhook, forwards to POST /webhook
 *   2. Dedup by resend email_id
 *   3. getOrCreateAgent(agentPath) — uses wasNewlyCreated to pick new vs reply format
 *   4. Fire-and-forget prompt to the agent via /api/agents/:path
 *
 * Structurally symmetric with slack.ts and webchat.ts — if you change the
 * pattern in one, update the others to match.
 */
import { Hono } from "hono";
import { nanoid } from "nanoid";
import { eq } from "drizzle-orm";
import { db } from "../db/index.ts";
import * as schema from "../db/schema.ts";
import { appRouter } from "../trpc/app-router.ts";

const logger = console;
const DAEMON_PORT = process.env.PORT || "3001";
const DAEMON_BASE_URL = `http://localhost:${DAEMON_PORT}`;
const AGENT_ROUTER_BASE_URL = `${DAEMON_BASE_URL}/api/agents`;

export const emailRouter = new Hono();

emailRouter.use("*", async (c, next) => {
  const reqBody = await c.req.raw.clone().text();
  logger.log(`[daemon/email] REQ ${c.req.method} ${c.req.path}`, reqBody);

  await next();

  const resBody = await c.res.clone().text();
  logger.log(`[daemon/email] RES ${c.res.status}`, resBody);
});

/**
 * Resend email.received payload (forwarded from OS backend)
 */
interface ResendEmailPayload {
  type: "email.received";
  created_at: string;
  data: {
    email_id: string;
    created_at: string;
    from: string;
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
  /** Added by OS backend */
  _iterate?: {
    userId: string;
    projectId: string;
    /** Email body content fetched from Resend API */
    emailBody?: {
      text: string;
      html: string;
    } | null;
  };
}

emailRouter.post("/webhook", async (c) => {
  const payload = (await c.req.json()) as ResendEmailPayload;

  // Only handle email.received events
  if (payload.type !== "email.received") {
    return c.json({ success: true, message: "Event type not handled" });
  }

  const emailData = payload.data;
  const resendEmailId = emailData.email_id;

  try {
    // Store the raw event for later inspection and dedup check
    const { eventId, isDuplicate } = await storeEvent(payload, resendEmailId);

    if (isDuplicate) {
      logger.log(`[daemon/email] Duplicate event, skipping`, { eventId, resendEmailId });
      return c.json({ success: true, message: "Duplicate event", eventId });
    }

    const { name: senderName, email: senderEmail } = parseSender(emailData.from);
    const subject = emailData.subject;
    const threadPathSegment = getThreadPathSegment(emailData);
    const agentPath = getAgentPath(threadPathSegment);
    const emailBody = payload._iterate?.emailBody;

    // Get or create the agent — wasNewlyCreated tells us if this is a new thread or a reply.
    const caller = appRouter.createCaller({});
    const { wasNewlyCreated } = await caller.daemon.getOrCreateAgent({
      agentPath,
      createWithEvents: [],
    });

    const message = wasNewlyCreated
      ? formatNewEmailMessage(
          agentPath,
          senderName,
          senderEmail,
          subject,
          emailData,
          emailBody,
          eventId,
        )
      : formatReplyMessage(
          agentPath,
          senderName,
          senderEmail,
          subject,
          emailData,
          emailBody,
          eventId,
        );

    // Fire-and-forget prompt to the agent, matching slack.ts / webchat.ts pattern.
    void fetch(`${AGENT_ROUTER_BASE_URL}${agentPath}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "iterate:agent:prompt-added", message }),
    }).catch((error) => {
      logger.error(`[email] failed to post prompt for ${agentPath}`, error);
    });

    return c.json({
      success: true,
      agentPath,
      created: wasNewlyCreated,
      case: wasNewlyCreated ? "new_email" : "reply",
      eventId,
    });
  } catch (error) {
    logger.error("[Email Webhook] Failed to handle webhook", error);
    return c.json({ error: "Internal server error" }, 500);
  }
});

// ────────────────────────── Helpers ──────────────────────────────────────────

/**
 * Parse sender name and email from "Name <email@domain.com>" format
 */
function parseSender(from: string): { name: string; email: string } {
  const match = from.match(/^(.+?)\s*<([^>]+)>$/);
  if (match) {
    return { name: match[1].trim(), email: match[2] };
  }
  return { name: from, email: from };
}

/**
 * Normalize subject for use as thread identifier.
 * Strips all Re:, Fwd:, etc. prefixes (including nested like "Re: Re: Fwd:") and normalizes whitespace.
 */
function normalizeSubject(subject: string): string {
  let result = subject;
  // Keep stripping prefixes until none remain
  let previous: string;
  do {
    previous = result;
    result = result.replace(/^(Re|Fwd|Fw):\s*/i, "");
  } while (result !== previous);

  return result.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Create a path-safe thread segment from email data
 */
function getThreadPathSegment(email: { subject: string; email_id: string }): string {
  const normalized = normalizeSubject(email.subject);

  // Handle empty/missing subjects by using email ID as fallback
  if (!normalized) {
    return `email-nosubject-${email.email_id}`.slice(0, 50);
  }

  // Create a short hash of the subject for the path segment
  let hash = 0;
  for (let i = 0; i < normalized.length; i++) {
    hash = (hash << 5) - hash + normalized.charCodeAt(i);
    hash |= 0;
  }
  const hashStr = Math.abs(hash).toString(36);
  // Take first few words + hash for readability
  const words = normalized
    .split(/\s+/)
    .slice(0, 3)
    .join("-")
    .replace(/[^a-z0-9-]/g, "");
  return `email-${words}-${hashStr}`.slice(0, 50);
}

function getAgentPath(threadPathSegment: string): string {
  return `/email/${threadPathSegment}`;
}

// ────────────────────────── Event storage ────────────────────────────────────

/**
 * Store the raw webhook event in SQLite for later inspection.
 * Returns { eventId, isDuplicate } so caller can skip processing duplicates.
 */
async function storeEvent(
  payload: ResendEmailPayload,
  resendEmailId: string,
): Promise<{ eventId: string; isDuplicate: boolean }> {
  // Check for existing event with same email_id (dedup)
  const existing = await db
    .select()
    .from(schema.events)
    .where(eq(schema.events.externalId, resendEmailId))
    .limit(1);
  if (existing[0]) {
    return { eventId: existing[0].id, isDuplicate: true };
  }

  const eventId = `evt_${nanoid(12)}`;
  await db.insert(schema.events).values({
    id: eventId,
    type: "email:received",
    externalId: resendEmailId,
    payload: payload as unknown as Record<string, unknown>,
  });

  return { eventId, isDuplicate: false };
}

// ────────────────────────── Message formatting ──────────────────────────────

/**
 * Format message for a new email (first in thread).
 */
function formatNewEmailMessage(
  agentPath: string,
  senderName: string,
  senderEmail: string,
  subject: string,
  emailData: ResendEmailPayload["data"],
  emailBody: { text: string; html: string } | null | undefined,
  eventId: string,
): string {
  const attachmentInfo =
    emailData.attachments.length > 0
      ? `\nAttachments: ${emailData.attachments.map((a) => a.filename).join(", ")}`
      : "";

  // Use plain text body if available, fallback to note about missing content
  const bodyContent = emailBody?.text
    ? `\n---\n${emailBody.text}\n---`
    : "\n(Email body could not be retrieved)";

  return [
    `[Agent Path: ${agentPath}] New email thread started.`,
    `Refer to EMAIL.md for how to respond via \`iterate tool exec-js\`.`,
    "",
    `From: ${senderName} <${senderEmail}>`,
    `To: ${emailData.to.join(", ")}`,
    `Subject: ${subject}`,
    attachmentInfo,
    bodyContent,
    "",
    `email_id=${emailData.email_id} message_id=${emailData.message_id} eventId=${eventId}`,
  ].join("\n");
}

/**
 * Format message for a reply email (continuing thread).
 */
function formatReplyMessage(
  agentPath: string,
  senderName: string,
  senderEmail: string,
  subject: string,
  emailData: ResendEmailPayload["data"],
  emailBody: { text: string; html: string } | null | undefined,
  eventId: string,
): string {
  const attachmentInfo =
    emailData.attachments.length > 0
      ? `\nAttachments: ${emailData.attachments.map((a) => a.filename).join(", ")}`
      : "";

  // Use plain text body if available, fallback to note about missing content
  const bodyContent = emailBody?.text
    ? `\n---\n${emailBody.text}\n---`
    : "\n(Email body could not be retrieved)";

  return [
    `Another email in agent thread ${agentPath}.`,
    "",
    `From: ${senderName} <${senderEmail}>`,
    `Subject: ${subject}`,
    attachmentInfo,
    bodyContent,
    "",
    `email_id=${emailData.email_id} message_id=${emailData.message_id} eventId=${eventId}`,
  ].join("\n");
}
