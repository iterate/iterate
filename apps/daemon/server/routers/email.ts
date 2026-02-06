/**
 * Email Router
 *
 * Handles incoming emails forwarded from the OS backend (Resend webhooks).
 * Creates/reuses agents per email thread and sends formatted messages.
 * Uses subject as thread identifier (similar to thread_ts in Slack).
 *
 * Message cases:
 * 1. New email - Creates a new agent for this email thread
 * 2. Reply email - Appends to existing agent (matched by subject)
 */
import { Hono } from "hono";
import { nanoid } from "nanoid";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "../db/index.ts";
import * as schema from "../db/schema.ts";
import type { IterateEvent } from "../types/events.ts";

const logger = console;
const DAEMON_PORT = process.env.PORT || "3001";
const DAEMON_BASE_URL = `http://localhost:${DAEMON_PORT}`;

export const emailRouter = new Hono();

// Middleware to log request and response bodies
emailRouter.use("*", async (c, next) => {
  const reqBody = await c.req.raw.clone().text();
  console.log(`[daemon/email] REQ ${c.req.method} ${c.req.path}`, reqBody);

  await next();

  const resBody = await c.res.clone().text();
  console.log(`[daemon/email] RES ${c.res.status}`, resBody);
});

async function agentExists(agentPath: string): Promise<boolean> {
  const existing = await db
    .select()
    .from(schema.agents)
    .where(and(eq(schema.agents.path, agentPath), isNull(schema.agents.archivedAt)))
    .limit(1);
  return Boolean(existing[0]);
}

async function sendToAgentGateway(
  agentPath: string,
  event: IterateEvent,
): Promise<{ wasCreated: boolean; route?: string | null }> {
  const response = await fetch(`${DAEMON_BASE_URL}/api/agents${agentPath}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(event),
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => "");
    throw new Error(
      `Agent gateway failed: ${response.status}${errorBody ? ` ${errorBody.slice(0, 500)}` : ""}`,
    );
  }

  const body = (await response.json().catch(() => ({}))) as {
    wasCreated?: boolean;
    route?: string | null;
  };

  if (typeof body !== "object" || body === null) {
    return { wasCreated: false, route: null };
  }

  return { wasCreated: body.wasCreated ?? false, route: body.route ?? null };
}

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
 * Create a slug-safe thread ID from email data
 */
function getSlug(email: { subject: string; email_id: string }): string {
  const normalized = normalizeSubject(email.subject);

  // Handle empty/missing subjects by using email ID as fallback
  if (!normalized) {
    return `email-nosubject-${email.email_id}`.slice(0, 50);
  }

  // Create a short hash of the subject for the slug
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

function getAgentPath(slug: string): string {
  return `/email/${slug}`;
}

emailRouter.post("/webhook", async (c) => {
  const payload = (await c.req.json()) as ResendEmailPayload;

  console.log(`[daemon/email] Received payload`, payload);

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
      console.log(`[daemon/email] Duplicate event, skipping`, { eventId, resendEmailId });
      return c.json({ success: true, message: "Duplicate event", eventId });
    }

    const { name: senderName, email: senderEmail } = parseSender(emailData.from);
    const subject = emailData.subject;
    const threadSlug = getSlug(emailData);
    const agentPath = getAgentPath(threadSlug);
    const emailBody = payload._iterate?.emailBody;

    const hasAgent = await agentExists(agentPath);

    if (hasAgent) {
      // Reply to existing thread
      const message = formatReplyMessage(
        threadSlug,
        senderName,
        senderEmail,
        subject,
        emailData,
        emailBody,
        eventId,
      );
      await sendToAgentGateway(agentPath, { type: "prompt", message });
      return c.json({
        success: true,
        agentPath,
        created: false,
        case: "reply",
        eventId,
      });
    }

    // New email thread - create agent via gateway
    const message = formatNewEmailMessage(
      threadSlug,
      senderName,
      senderEmail,
      subject,
      emailData,
      emailBody,
      eventId,
    );
    const { wasCreated } = await sendToAgentGateway(agentPath, { type: "prompt", message });

    return c.json({
      success: true,
      agentPath,
      created: wasCreated,
      case: "new_email",
      eventId,
    });
  } catch (error) {
    logger.error("[Email Webhook] Failed to handle webhook", error);
    return c.json({ error: "Internal server error" }, 500);
  }
});

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

/**
 * Format message for a new email (first in thread).
 */
function formatNewEmailMessage(
  agentSlug: string,
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
    `[Agent: ${agentSlug}] New email thread started.`,
    `Refer to EMAIL.md for how to respond via \`iterate tool email\`.`,
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
  agentSlug: string,
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
    `Another email in thread ${agentSlug}.`,
    "",
    `From: ${senderName} <${senderEmail}>`,
    `Subject: ${subject}`,
    attachmentInfo,
    bodyContent,
    "",
    `email_id=${emailData.email_id} message_id=${emailData.message_id} eventId=${eventId}`,
  ].join("\n");
}
