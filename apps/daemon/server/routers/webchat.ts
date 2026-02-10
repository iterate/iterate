/**
 * Webchat Router
 *
 * Handles incoming webchat messages forwarded from the OS backend.
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

const logger = console;
// Ephemeral per-thread status shown in webchat UI (similar UX to Slack's transient activity text).
const threadStatuses = new Map<string, string>();
const threadIdByAgentPath = new Map<string, string>();
const DAEMON_BASE_URL = `http://localhost:${process.env.PORT || "3001"}`;
const AGENT_ROUTER_BASE_URL = `${DAEMON_BASE_URL}/api/agents`;
const WEBCHAT_ROUTER_BASE_URL = `${DAEMON_BASE_URL}/api/integrations/webchat`;

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

  const agentPath = getAgentPathForThread(threadId);
  const existedBefore = await agentExists(agentPath);

  const userMessage: StoredMessage = {
    threadId,
    messageId,
    role: "user",
    text: payload.text,
    userId: payload.userId,
    userName: payload.userName,
    attachments: payload.attachments,
    createdAt,
  };

  const eventId = await storeEvent("webchat:user-message", userMessage, messageId);

  const formattedMessage = formatIncomingMessage({
    payload,
    threadId,
    messageId,
    eventId,
    isFirstMessageInThread: !existedBefore,
  });

  void fetch(`${AGENT_ROUTER_BASE_URL}${agentPath}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "prompt", message: formattedMessage }),
  })
    .then(async (response) => {
      if (!response.ok) {
        const errorBody = await response.text().catch(() => "");
        throw new Error(
          `Agent gateway failed: ${response.status}${errorBody ? ` ${errorBody.slice(0, 500)}` : ""}`,
        );
      }
      threadIdByAgentPath.set(agentPath, threadId);
      await trpcRouter.createCaller({}).subscribeToAgentChanges({
        agentPath,
        callbackUrl: getWebchatAgentChangeCallbackUrl(),
      });
    })
    .catch((error) => {
      logger.error(`[webchat] failed to post prompt event for ${threadId}/${messageId}`, error);
    });

  return c.json({
    success: true,
    duplicate: false,
    threadId,
    messageId,
    eventId,
    created: !existedBefore,
  });
});

webchatRouter.post("/postMessage", async (c) => {
  const parsed = PostMessagePayload.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: "Invalid payload", issues: parsed.error.issues }, 400);
  }

  const { threadId, text } = parsed.data;
  const messageId = parsed.data.messageId ?? `msg_${nanoid(12)}`;

  const assistantMessage: StoredMessage = {
    threadId,
    messageId,
    role: "assistant",
    text,
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
  threadStatuses.set(threadId, status);

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
  const threadId = threadIdByAgentPath.get(payload.path);
  if (!threadId) {
    logger.log(`[webchat] ignoring agent-change without mapped thread: ${payload.path}`);
    return c.json({ success: true, ignored: true });
  }

  threadStatuses.set(threadId, payload.shortStatus);
  logger.log(
    `[webchat] status update thread=${threadId} path=${payload.path} working=${payload.isWorking} status="${payload.shortStatus}"`,
  );
  return c.json({ success: true });
});

function getWebchatAgentChangeCallbackUrl(): string {
  return `${WEBCHAT_ROUTER_BASE_URL}/agent-change-callback`;
}

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
  const status = threadStatuses.get(threadId) ?? "";
  return c.json({ threadId, messages, agentSessionUrl, status });
});

/**
 * Check whether an active agent exists for the given path via tRPC.
 * The agents router handles getOrCreateAgent automatically when we POST
 * to it, so this is only needed to determine first-vs-reply message format.
 */
async function agentExists(agentPath: string): Promise<boolean> {
  const agent = await trpcRouter.createCaller({}).getAgent({ path: agentPath });
  return agent !== null;
}

function createThreadId(): string {
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
  eventId: string;
  isFirstMessageInThread: boolean;
}): string {
  const { payload, threadId, messageId, eventId, isFirstMessageInThread } = params;

  const intro = isFirstMessageInThread
    ? "New webchat thread started."
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
