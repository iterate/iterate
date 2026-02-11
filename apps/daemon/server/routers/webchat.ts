/**
 * Webchat Router
 *
 * Handles incoming webchat messages forwarded from the OS backend.
 *
 * Structurally symmetric with slack.ts and email.ts — if you change the
 * pattern in one, update the others to match.
 *
 * ## Architecture (canonical reference -- slack.ts and email.ts point here)
 *
 * Message flow:
 *
 *   OS Backend (webhook) -> Integration Router (slack / webchat / email)
 *        |                                                         ^
 *        |  1. tRPC getOrCreateAgent (ensures agent + route exist) |
 *        |  2. fire-and-forget fetch to /api/agents/:path          |
 *        v                                                         |
 *   AgentsRouter -> OpenCodeRouter -> OpenCode SDK                 |
 *                                         |                        |
 *                  client.global.event()   |                        |
 *                  (SDK event stream)      v                        |
 *                              idle/tool events                     |
 *                                         |                        |
 *                         tRPC updateAgent |                        |
 *                                         v                        |
 *                            AgentChangeCallbacks --(POST)---------+
 *
 * The callback delivers `iterate:agent-updated` events. This is the only
 * event type today, but the callback URL is conceptually a subscription to
 * an iterate-level event stream about the agent. In the future, other
 * iterate-level or raw OpenCode events may be delivered on the same channel.
 */
import { Hono } from "hono";
import { nanoid } from "nanoid";
import { eq, and, inArray, asc } from "drizzle-orm";
import { z } from "zod/v4";
import { db } from "../db/index.ts";
import * as schema from "../db/schema.ts";
import { trpcRouter } from "../trpc/router.ts";
import { runAgentCommand } from "../utils/agent-commands.ts";

const logger = console;
// Ephemeral per-thread status shown in webchat UI (similar UX to Slack's transient activity text).
const webchatThreadStatuses = new Map<string, string>();
const webchatThreadIdByAgentPath = new Map<string, string>();
const DAEMON_BASE_URL = `http://localhost:${process.env.PORT || "3001"}`;
const AGENT_ROUTER_BASE_URL = `${DAEMON_BASE_URL}/api/agents`;
const WEBCHAT_AGENT_CHANGE_CALLBACK_URL = `${DAEMON_BASE_URL}/api/integrations/webchat/agent-change-callback`;

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

  const webchatThreadId = payload.threadId ?? createWebchatThreadId();
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
      return c.json({ success: true, duplicate: true, threadId: webchatThreadId });
    }
  }

  const agentPath = getAgentPathForThread(webchatThreadId);
  const caller = trpcRouter.createCaller({});
  const { agent, wasNewlyCreated } = await caller.getOrCreateAgent({
    agentPath,
    createWithEvents: [],
  });

  webchatThreadIdByAgentPath.set(agentPath, webchatThreadId);

  if (wasNewlyCreated) {
    void caller.subscribeToAgentChanges({
      agentPath,
      callbackUrl: WEBCHAT_AGENT_CHANGE_CALLBACK_URL,
    });
  }

  const userMessage: StoredMessage = {
    threadId: webchatThreadId,
    messageId,
    role: "user",
    text: payload.text,
    userId: payload.userId,
    userName: payload.userName,
    attachments: payload.attachments,
    createdAt,
  };

  const eventId = await storeEvent("webchat:user-message", userMessage, messageId);
  const commandResult = await runAgentCommand({
    message: payload.text || "",
    agentPath,
    agent,
    rendererHint: "apps/daemon/server/routers/webchat.ts",
  });

  if (commandResult) {
    const assistantMessageId = `msg_${nanoid(12)}`;
    const assistantText = commandResult.resultMarkdown;
    const assistantMessage: StoredMessage = {
      threadId: webchatThreadId,
      messageId: assistantMessageId,
      role: "assistant",
      text: assistantText,
      createdAt: Date.now(),
    };
    const assistantEventId = await storeEvent(
      "webchat:assistant-message",
      assistantMessage,
      assistantMessageId,
    );

    return c.json({
      success: true,
      duplicate: false,
      threadId: webchatThreadId,
      messageId,
      eventId,
      created: false,
      queued: false,
      case: `${commandResult.command}_command`,
      assistantMessageId,
      assistantEventId,
    });
  }

  const formattedMessage = formatIncomingMessage({
    payload,
    webchatThreadId,
    messageId,
    eventId,
    isFirstMessageInThread: wasNewlyCreated,
  });

  void fetch(`${AGENT_ROUTER_BASE_URL}${agentPath}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "iterate:agent:prompt-added", message: formattedMessage }),
  }).catch((error) => {
    logger.error(
      `[webchat] failed to post prompt event for ${webchatThreadId}/${messageId}`,
      error,
    );
  });

  return c.json({
    success: true,
    duplicate: false,
    threadId: webchatThreadId,
    messageId,
    eventId,
    created: wasNewlyCreated,
  });
});

webchatRouter.post("/postMessage", async (c) => {
  const parsed = PostMessagePayload.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: "Invalid payload", issues: parsed.error.issues }, 400);
  }

  const { threadId: webchatThreadId, text } = parsed.data;
  const messageId = parsed.data.messageId ?? `msg_${nanoid(12)}`;

  const assistantMessage: StoredMessage = {
    threadId: webchatThreadId,
    messageId,
    role: "assistant",
    text,
    attachments: parsed.data.attachments,
    createdAt: Date.now(),
  };

  const eventId = await storeEvent("webchat:assistant-message", assistantMessage, messageId);

  return c.json({ success: true, threadId: webchatThreadId, messageId, eventId });
});

webchatRouter.post("/addReaction", async (c) => {
  const parsed = ReactionPayload.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: "Invalid payload", issues: parsed.error.issues }, 400);
  }

  const { threadId: webchatThreadId, messageId, reaction } = parsed.data;
  const eventId = await storeEvent("webchat:reaction-added", {
    threadId: webchatThreadId,
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

  const { threadId: webchatThreadId, messageId, reaction } = parsed.data;
  const eventId = await storeEvent("webchat:reaction-removed", {
    threadId: webchatThreadId,
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

  const { threadId: webchatThreadId, status } = parsed.data;
  webchatThreadStatuses.set(webchatThreadId, status);

  return c.json({ success: true });
});

/**
 * Receives `iterate:agent-updated` events from the agent change callback system.
 * This is currently the only event type. In the future, other iterate-level
 * or raw OpenCode events may be delivered on this same callback channel.
 */
webchatRouter.post("/agent-change-callback", async (c) => {
  const parsed = z
    .object({
      type: z.literal("iterate:agent-updated"),
      payload: z
        .object({
          path: z.string(),
          shortStatus: z.string(),
          isWorking: z.boolean(),
        })
        .passthrough(),
    })
    .safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: "Invalid payload", issues: parsed.error.issues }, 400);
  }

  const { payload } = parsed.data;
  const webchatThreadId = webchatThreadIdByAgentPath.get(payload.path);
  if (!webchatThreadId) {
    logger.log(`[webchat] ignoring agent-change without mapped thread: ${payload.path}`);
    return c.json({ success: true, ignored: true });
  }

  webchatThreadStatuses.set(webchatThreadId, payload.shortStatus);
  logger.log(
    `[webchat] status update thread=${webchatThreadId} path=${payload.path} working=${payload.isWorking} status="${payload.shortStatus}"`,
  );
  return c.json({ success: true });
});

webchatRouter.get("/threads", async (c) => {
  const messages = await listStoredMessages();
  const threads = buildThreadSummaries(messages);
  return c.json({ threads });
});

webchatRouter.get("/threads/:threadId/messages", async (c) => {
  const webchatThreadId = c.req.param("threadId");
  const messages = (await listStoredMessages())
    .filter((message) => message.threadId === webchatThreadId)
    .sort((a, b) => a.createdAt - b.createdAt);

  const status = webchatThreadStatuses.get(webchatThreadId) ?? "";
  return c.json({ threadId: webchatThreadId, messages, status });
});

function createWebchatThreadId(): string {
  return `thread-${Date.now().toString(36)}-${nanoid(8)}`;
}

function sanitizeForSegment(value: string, maxLength: number): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, maxLength) || "thread"
  );
}

function sanitizeForPathSegment(value: string): string {
  return sanitizeForSegment(value, 80);
}

function getAgentPathForThread(webchatThreadId: string): string {
  return `/webchat/${sanitizeForPathSegment(webchatThreadId)}`;
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
  webchatThreadId: string;
  messageId: string;
  eventId: string;
  isFirstMessageInThread: boolean;
}): string {
  const { payload, webchatThreadId, messageId, eventId, isFirstMessageInThread } = params;

  const intro = isFirstMessageInThread
    ? "New webchat thread started."
    : `Another message in webchat thread ${webchatThreadId}.`;

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
    `thread_id=${webchatThreadId} message_id=${messageId} eventId=${eventId}`,
  ].join("\n");
}
