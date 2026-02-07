import { eq, and, inArray, asc } from "drizzle-orm";
import { Hono } from "hono";
import { nanoid } from "nanoid";
import { z } from "zod/v4";
import { db } from "../db/index.ts";
import * as schema from "../db/schema.ts";
import { appendToAgent, createAgent, getAgent } from "../services/agent-manager.ts";
import { getCustomerRepoPath } from "../trpc/platform.ts";

const logger = console;

const WebChatWebhookPayload = z.object({
  type: z.literal("web-chat:message").optional(),
  threadId: z.string().trim().min(1).max(200).optional(),
  messageId: z.string().trim().min(1).max(200).optional(),
  text: z.string().trim().min(1).max(50_000),
  userId: z.string().trim().min(1).max(200).optional(),
  userName: z.string().trim().min(1).max(200).optional(),
  projectId: z.string().trim().min(1).max(200).optional(),
  projectSlug: z.string().trim().min(1).max(200).optional(),
  createdAt: z.number().int().positive().optional(),
});

const WebChatStoredMessage = z.object({
  threadId: z.string(),
  messageId: z.string(),
  role: z.enum(["user", "assistant"]),
  text: z.string(),
  userId: z.string().optional(),
  userName: z.string().optional(),
  sourceEventId: z.string().optional(),
  sourceMessageId: z.string().optional(),
  agentSlug: z.string(),
  createdAt: z.number().int().positive(),
});

type WebChatStoredMessage = z.infer<typeof WebChatStoredMessage>;

const webChatEventTypes = ["web-chat:user-message", "web-chat:assistant-message"] as const;

export const webChatRouter = new Hono();

webChatRouter.post("/webhook", async (c) => {
  const parsedPayload = WebChatWebhookPayload.safeParse(await c.req.json());
  if (!parsedPayload.success) {
    return c.json({ error: "Invalid webhook payload", issues: parsedPayload.error.issues }, 400);
  }

  const payload = parsedPayload.data;
  const threadId = payload.threadId ?? createThreadId();
  const messageId = payload.messageId ?? `msg_${nanoid(12)}`;
  const createdAt = payload.createdAt ?? Date.now();
  const { agentSlug, agent: existingAgent } = await findAgentForThread(threadId);

  // Idempotency for retries from UI/network hiccups.
  if (payload.messageId) {
    const existingMessage = await db
      .select()
      .from(schema.events)
      .where(
        and(
          eq(schema.events.type, "web-chat:user-message"),
          eq(schema.events.externalId, payload.messageId),
        ),
      )
      .limit(1);

    if (existingMessage[0]) {
      const stored = parseStoredMessage(existingMessage[0].payload);
      if (stored) {
        return c.json({
          success: true,
          duplicate: true,
          threadId: stored.threadId,
          agentSlug: stored.agentSlug,
          created: false,
          userMessage: stored,
        });
      }
    }
  }

  const userMessage: WebChatStoredMessage = {
    threadId,
    messageId,
    role: "user",
    text: payload.text,
    userId: payload.userId,
    userName: payload.userName,
    agentSlug,
    createdAt,
  };

  const userEventId = await storeEvent("web-chat:user-message", userMessage, messageId);

  let agent = existingAgent;
  let wasCreated = false;
  const workingDirectory = await getCustomerRepoPath();

  if (!agent) {
    wasCreated = true;
    agent = await createAgent({
      slug: agentSlug,
      harnessType: "opencode",
      workingDirectory,
      initialPrompt: [
        `[Agent slug: ${agentSlug}]`,
        "[Source: web-chat]",
        `[Thread: ${threadId}]`,
        "You are responding in the Iterate web chat UI.",
      ].join("\n"),
    });
  }

  const messageForAgent = formatWebChatMessage({
    payload,
    threadId,
    messageId,
    agentSlug,
    eventId: userEventId,
    isFirstMessageInThread: wasCreated,
  });

  const appendResult = await appendToAgent(agent, messageForAgent, {
    workingDirectory,
    acknowledge: async () => logger.log(`[web-chat] Processing message ${threadId}/${messageId}`),
    unacknowledge: async () => logger.log(`[web-chat] Finished message ${threadId}/${messageId}`),
  });

  const assistantText = appendResult?.assistantMessage?.text?.trim() ?? "";
  let assistantMessage: WebChatStoredMessage | null = null;
  let assistantEventId: string | null = null;

  if (assistantText) {
    assistantMessage = {
      threadId,
      messageId: `msg_${nanoid(12)}`,
      sourceMessageId: messageId,
      sourceEventId: userEventId,
      role: "assistant",
      text: assistantText,
      agentSlug,
      createdAt: Date.now(),
    };
    assistantEventId = await storeEvent("web-chat:assistant-message", assistantMessage);
  }

  return c.json({
    success: true,
    duplicate: false,
    threadId,
    messageId,
    eventId: userEventId,
    assistantEventId,
    created: wasCreated,
    agentSlug,
    userMessage,
    assistantMessage,
  });
});

webChatRouter.get("/threads", async (c) => {
  const messages = await listStoredMessages();
  const threads = buildThreadSummaries(messages);
  return c.json({ threads });
});

webChatRouter.get("/threads/:threadId/messages", async (c) => {
  const threadId = c.req.param("threadId");
  const messages = (await listStoredMessages())
    .filter((message) => message.threadId === threadId)
    .sort((a, b) => a.createdAt - b.createdAt);
  return c.json({ threadId, messages });
});

function createThreadId(): string {
  return `thread-${Date.now().toString(36)}-${nanoid(8)}`;
}

function sanitizeThreadIdForSlug(threadId: string): string {
  const sanitized = threadId
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return sanitized || "thread";
}

async function findAgentForThread(
  threadId: string,
): Promise<{ agent: Awaited<ReturnType<typeof getAgent>>; agentSlug: string }> {
  const agentSlug = `web-chat-${sanitizeThreadIdForSlug(threadId)}`;
  const agent = await getAgent(agentSlug);
  return { agent, agentSlug };
}

async function storeEvent(
  type: "web-chat:user-message" | "web-chat:assistant-message",
  payload: WebChatStoredMessage,
  externalId?: string,
): Promise<string> {
  const eventId = `evt_${nanoid(12)}`;
  await db.insert(schema.events).values({
    id: eventId,
    type,
    externalId,
    payload: payload as unknown as Record<string, unknown>,
  });
  return eventId;
}

function parseStoredMessage(payload: Record<string, unknown> | null): WebChatStoredMessage | null {
  if (!payload) return null;
  const parsed = WebChatStoredMessage.safeParse(payload);
  return parsed.success ? parsed.data : null;
}

async function listStoredMessages(): Promise<WebChatStoredMessage[]> {
  const events = await db
    .select()
    .from(schema.events)
    .where(inArray(schema.events.type, [...webChatEventTypes]))
    .orderBy(asc(schema.events.createdAt));

  return events
    .map((event) => parseStoredMessage(event.payload))
    .filter((message): message is WebChatStoredMessage => message !== null);
}

function buildThreadSummaries(messages: WebChatStoredMessage[]) {
  const byThread = new Map<string, WebChatStoredMessage[]>();
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
        agentSlug: lastMessage?.agentSlug ?? `web-chat-${sanitizeThreadIdForSlug(threadId)}`,
        messageCount: sorted.length,
        title: (firstUserMessage?.text ?? "New thread").slice(0, 120),
        lastMessagePreview: (lastMessage?.text ?? "").slice(0, 160),
        lastMessageRole: lastMessage?.role ?? "user",
        lastMessageAt: lastMessage?.createdAt ?? 0,
      };
    })
    .sort((a, b) => b.lastMessageAt - a.lastMessageAt);
}

function formatWebChatMessage(params: {
  payload: z.infer<typeof WebChatWebhookPayload>;
  threadId: string;
  messageId: string;
  agentSlug: string;
  eventId: string;
  isFirstMessageInThread: boolean;
}): string {
  const { payload, threadId, messageId, agentSlug, eventId, isFirstMessageInThread } = params;

  const intro = isFirstMessageInThread
    ? `[Agent: ${agentSlug}] New web chat thread started.`
    : `Another message in web chat thread ${threadId}.`;

  const sender = payload.userName ?? payload.userId ?? "unknown";

  return [
    intro,
    "Refer to WEB_CHAT.md for this channel's response expectations.",
    "",
    `From: ${sender}`,
    `Message: ${payload.text}`,
    "",
    `thread_id=${threadId} message_id=${messageId} eventId=${eventId}`,
  ].join("\n");
}
