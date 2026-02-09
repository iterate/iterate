/**
 * Webchat Router
 *
 * Handles incoming webchat messages forwarded from the OS backend.
 * Uses path-based agents and a webchat-specific SSE consumer for status lifecycle.
 */
import { Hono } from "hono";
import { nanoid } from "nanoid";
import { eq, and, inArray, asc } from "drizzle-orm";
import { z } from "zod/v4";
import { activeAgentExists, sendToAgentGateway } from "../utils/agent-gateway.ts";
import { db } from "../db/index.ts";
import * as schema from "../db/schema.ts";
import {
  getWebchatThreadStatus,
  registerWebchatWork,
  setWebchatThreadStatus,
} from "../services/webchat-stream-consumer.ts";

const logger = console;

const Attachment = z.object({
  fileName: z.string(),
  filePath: z.string(),
  mimeType: z.string().optional(),
  size: z.number().optional(),
});

const IncomingWebhookPayload = z.object({
  type: z.literal("webchat:message").optional(),
  threadId: z.string().trim().min(1).max(200).optional(),
  messageId: z.string().trim().min(1).max(200).optional(),
  text: z.string().trim().max(50_000).optional().default(""),
  userId: z.string().trim().min(1).max(200).optional(),
  userName: z.string().trim().min(1).max(200).optional(),
  projectId: z.string().trim().min(1).max(200).optional(),
  projectSlug: z.string().trim().min(1).max(200).optional(),
  attachments: z.array(Attachment).optional(),
  createdAt: z.number().int().positive().optional(),
});

const PostMessagePayload = z.object({
  threadId: z.string().trim().min(1).max(200),
  text: z.string().trim().max(50_000).optional().default(""),
  messageId: z.string().trim().min(1).max(200).optional(),
  attachments: z.array(Attachment).optional(),
});

const ReactionPayload = z.object({
  threadId: z.string().trim().min(1).max(200),
  messageId: z.string().trim().min(1).max(200),
  reaction: z.string().trim().min(1).max(100),
});

const SetStatusPayload = z.object({
  threadId: z.string().trim().min(1).max(200),
  status: z.string().trim().max(30),
});

const StoredMessage = z.object({
  threadId: z.string(),
  messageId: z.string(),
  role: z.enum(["user", "assistant"]),
  text: z.string(),
  userId: z.string().optional(),
  userName: z.string().optional(),
  agentSlug: z.string(),
  reactions: z.array(z.string()).optional(),
  attachments: z.array(Attachment).optional(),
  createdAt: z.number().int().positive(),
});

type StoredMessage = z.infer<typeof StoredMessage>;

type WebchatEventType =
  | "webchat:user-message"
  | "webchat:assistant-message"
  | "webchat:reaction-added"
  | "webchat:reaction-removed";

export const webchatRouter = new Hono();

webchatRouter.use("*", async (c, next) => {
  const reqBody = await c.req.raw.clone().text();
  logger.log(`[daemon/webchat] REQ ${c.req.method} ${c.req.path}`, reqBody.slice(0, 500));
  await next();
  const resBody = await c.res.clone().text();
  logger.log(`[daemon/webchat] RES ${c.res.status}`, resBody.slice(0, 500));
});

webchatRouter.post("/webhook", async (c) => {
  const parsed = IncomingWebhookPayload.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: "Invalid webhook payload", issues: parsed.error.issues }, 400);
  }

  const payload = parsed.data;
  if (!payload.text && (!payload.attachments || payload.attachments.length === 0)) {
    return c.json({ error: "Message must have text or attachments" }, 400);
  }

  const threadId = payload.threadId ?? createThreadId();
  const messageId = payload.messageId ?? `msg_${nanoid(12)}`;
  const createdAt = payload.createdAt ?? Date.now();

  if (payload.messageId) {
    const existing = await db
      .select()
      .from(schema.events)
      .where(
        and(
          eq(schema.events.type, "webchat:user-message"),
          eq(schema.events.externalId, payload.messageId),
        ),
      )
      .limit(1);

    if (existing[0]) {
      return c.json({ success: true, duplicate: true, threadId });
    }
  }

  const agentSlug = agentSlugForThread(threadId);
  const agentPath = getAgentPathForThread(threadId);
  const existedBefore = await activeAgentExists(agentPath);

  const userMessage: StoredMessage = {
    threadId,
    messageId,
    role: "user",
    text: payload.text,
    userId: payload.userId,
    userName: payload.userName,
    agentSlug,
    attachments: payload.attachments,
    createdAt,
  };

  const eventId = await storeEvent("webchat:user-message", userMessage, messageId);

  registerWebchatWork({
    agentPath,
    threadId,
    messageId,
  });

  const formattedMessage = formatIncomingMessage({
    payload,
    threadId,
    messageId,
    agentSlug,
    eventId,
    isFirstMessageInThread: !existedBefore,
  });

  await sendToAgentGateway(agentPath, { type: "prompt", message: formattedMessage });

  return c.json({
    success: true,
    duplicate: false,
    threadId,
    messageId,
    eventId,
    created: !existedBefore,
    agentSlug,
  });
});

webchatRouter.post("/postMessage", async (c) => {
  const parsed = PostMessagePayload.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: "Invalid payload", issues: parsed.error.issues }, 400);
  }

  const { threadId, text } = parsed.data;
  const messageId = parsed.data.messageId ?? `msg_${nanoid(12)}`;
  const agentSlug = agentSlugForThread(threadId);

  const assistantMessage: StoredMessage = {
    threadId,
    messageId,
    role: "assistant",
    text,
    agentSlug,
    attachments: parsed.data.attachments,
    createdAt: Date.now(),
  };

  const eventId = await storeEvent("webchat:assistant-message", assistantMessage, messageId);

  return c.json({ success: true, threadId, messageId, eventId });
});

webchatRouter.post("/addReaction", async (c) => {
  const parsed = ReactionPayload.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: "Invalid payload", issues: parsed.error.issues }, 400);
  }

  const { threadId, messageId, reaction } = parsed.data;
  const eventId = await storeEvent("webchat:reaction-added", {
    threadId,
    messageId,
    reaction,
    createdAt: Date.now(),
  });

  return c.json({ success: true, eventId });
});

webchatRouter.post("/removeReaction", async (c) => {
  const parsed = ReactionPayload.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: "Invalid payload", issues: parsed.error.issues }, 400);
  }

  const { threadId, messageId, reaction } = parsed.data;
  const eventId = await storeEvent("webchat:reaction-removed", {
    threadId,
    messageId,
    reaction,
    createdAt: Date.now(),
  });

  return c.json({ success: true, eventId });
});

webchatRouter.post("/setStatus", async (c) => {
  const parsed = SetStatusPayload.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: "Invalid payload", issues: parsed.error.issues }, 400);
  }

  const { threadId, status } = parsed.data;
  setWebchatThreadStatus(threadId, status);

  return c.json({ success: true });
});

webchatRouter.get("/threads", async (c) => {
  const messages = await listStoredMessages();
  const threads = buildThreadSummaries(messages);
  return c.json({ threads });
});

webchatRouter.get("/threads/:threadId/messages", async (c) => {
  const threadId = c.req.param("threadId");
  const messages = (await listStoredMessages())
    .filter((message) => message.threadId === threadId)
    .sort((a, b) => a.createdAt - b.createdAt);

  const agentSessionUrl = await getThreadAgentSessionUrl(threadId);
  const status = getWebchatThreadStatus(threadId);
  return c.json({ threadId, messages, agentSessionUrl, status });
});

function createThreadId(): string {
  return `thread-${Date.now().toString(36)}-${nanoid(8)}`;
}

function sanitizeForSlug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 50) || "thread"
  );
}

function sanitizeForPathSegment(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 80) || "thread"
  );
}

function agentSlugForThread(threadId: string): string {
  return `webchat-${sanitizeForSlug(threadId)}`;
}

function getAgentPathForThread(threadId: string): string {
  return `/webchat/${sanitizeForPathSegment(threadId)}`;
}

const SessionEnv = z.object({
  ITERATE_OS_BASE_URL: z.string(),
  ITERATE_ORG_SLUG: z.string(),
  ITERATE_PROJECT_SLUG: z.string(),
  ITERATE_MACHINE_ID: z.string(),
  ITERATE_CUSTOMER_REPO_PATH: z.string(),
});

function buildAgentSessionUrl(sessionId: string, workingDirectory?: string | null): string {
  const env = SessionEnv.parse(process.env);
  const dir = workingDirectory ?? env.ITERATE_CUSTOMER_REPO_PATH;
  const command = `opencode attach 'http://localhost:4096' --session ${sessionId} --dir ${dir}`;
  const proxyUrl = `${env.ITERATE_OS_BASE_URL}/org/${env.ITERATE_ORG_SLUG}/proj/${env.ITERATE_PROJECT_SLUG}/${env.ITERATE_MACHINE_ID}/proxy/3000`;
  return `${proxyUrl}/terminal?${new URLSearchParams({ command, autorun: "true" })}`;
}

async function getThreadAgentSessionUrl(threadId: string): Promise<string | undefined> {
  const agentPath = getAgentPathForThread(threadId);
  const route = await db
    .select()
    .from(schema.agentRoutes)
    .where(and(eq(schema.agentRoutes.agentPath, agentPath), eq(schema.agentRoutes.active, true)))
    .limit(1);

  const destination = route[0]?.destination;
  if (!destination) return undefined;

  const match = destination.match(/^\/opencode\/sessions\/(.+)$/);
  if (!match) return undefined;

  return buildAgentSessionUrl(match[1]);
}

async function storeEvent(
  type: WebchatEventType,
  payload: Record<string, unknown>,
  externalId?: string,
): Promise<string> {
  const eventId = `evt_${nanoid(12)}`;
  await db.insert(schema.events).values({
    id: eventId,
    type,
    externalId,
    payload,
  });
  return eventId;
}

function parseStoredMessage(payload: Record<string, unknown> | null): StoredMessage | null {
  if (!payload) return null;
  const parsed = StoredMessage.safeParse(payload);
  return parsed.success ? parsed.data : null;
}

async function listStoredMessages(): Promise<StoredMessage[]> {
  const events = await db
    .select()
    .from(schema.events)
    .where(inArray(schema.events.type, ["webchat:user-message", "webchat:assistant-message"]))
    .orderBy(asc(schema.events.createdAt));

  return events
    .map((event) => parseStoredMessage(event.payload))
    .filter((message): message is StoredMessage => message !== null);
}

function buildThreadSummaries(messages: StoredMessage[]) {
  const byThread = new Map<string, StoredMessage[]>();
  for (const message of messages) {
    const threadMessages = byThread.get(message.threadId) ?? [];
    threadMessages.push(message);
    byThread.set(message.threadId, threadMessages);
  }

  return Array.from(byThread.entries())
    .map(([threadId, threadMessages]) => {
      const sorted = [...threadMessages].sort((a, b) => a.createdAt - b.createdAt);
      const firstUserMessage = sorted.find((message) => message.role === "user");
      const lastMessage = sorted[sorted.length - 1];

      return {
        threadId,
        agentSlug: lastMessage?.agentSlug ?? agentSlugForThread(threadId),
        messageCount: sorted.length,
        title: (firstUserMessage?.text ?? "New thread").slice(0, 120),
        lastMessagePreview: (lastMessage?.text ?? "").slice(0, 160),
        lastMessageRole: lastMessage?.role ?? "user",
        lastMessageAt: lastMessage?.createdAt ?? 0,
      };
    })
    .sort((a, b) => b.lastMessageAt - a.lastMessageAt);
}

function formatIncomingMessage(params: {
  payload: z.infer<typeof IncomingWebhookPayload>;
  threadId: string;
  messageId: string;
  agentSlug: string;
  eventId: string;
  isFirstMessageInThread: boolean;
}): string {
  const { payload, threadId, messageId, agentSlug, eventId, isFirstMessageInThread } = params;

  const intro = isFirstMessageInThread
    ? `[Agent: ${agentSlug}] New webchat thread started.`
    : `Another message in webchat thread ${threadId}.`;

  const sender = payload.userName ?? payload.userId ?? "unknown";

  const attachmentLines =
    payload.attachments && payload.attachments.length > 0
      ? [
          "",
          "Attachments:",
          ...payload.attachments.map(
            (a) => `  - ${a.fileName} (${a.mimeType ?? "unknown type"}, path: ${a.filePath})`,
          ),
        ]
      : [];

  return [
    intro,
    "Refer to WEBCHAT.md for how to respond via `iterate tool webchat`. Do not use the assistant message to respond to the end-user, they will not see it.",
    "",
    `From: ${sender}`,
    ...(payload.text ? [`Message: ${payload.text}`] : []),
    ...attachmentLines,
    "",
    `thread_id=${threadId} message_id=${messageId} eventId=${eventId}`,
  ].join("\n");
}
