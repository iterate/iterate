import { Hono, type Context } from "hono";
import { and, eq } from "drizzle-orm";
import { z } from "zod/v4";
import type { CloudflareEnv } from "../../../env.ts";
import type { Variables } from "../../types.ts";
import * as schema from "../../db/schema.ts";
import { logger } from "../../tag-logger.ts";
import { createMachineProvider } from "../../providers/index.ts";

const WebChatAttachment = z.object({
  fileName: z.string(),
  filePath: z.string(),
  mimeType: z.string().optional(),
  size: z.number().optional(),
});

const WebChatMessage = z.object({
  threadId: z.string(),
  messageId: z.string(),
  role: z.enum(["user", "assistant"]),
  text: z.string(),
  userId: z.string().optional(),
  userName: z.string().optional(),
  agentSlug: z.string(),
  reactions: z.array(z.string()).optional(),
  attachments: z.array(WebChatAttachment).optional(),
  createdAt: z.number(),
});

const WebChatThread = z.object({
  threadId: z.string(),
  agentSlug: z.string(),
  messageCount: z.number(),
  title: z.string(),
  lastMessagePreview: z.string(),
  lastMessageRole: z.enum(["user", "assistant"]),
  lastMessageAt: z.number(),
});

const WebChatWebhookResponse = z.object({
  success: z.boolean(),
  duplicate: z.boolean().optional(),
  threadId: z.string(),
  messageId: z.string().optional(),
  eventId: z.string().optional(),
  created: z.boolean().optional(),
  agentSlug: z.string().optional(),
});

const WebChatThreadsResponse = z.object({
  threads: z.array(WebChatThread),
});

const WebChatMessagesResponse = z.object({
  threadId: z.string(),
  messages: z.array(WebChatMessage),
  agentSessionUrl: z.string().optional(),
});

const WebhookInput = z.object({
  projectSlug: z.string().min(1),
  threadId: z.string().min(1).optional(),
  messageId: z.string().min(1).optional(),
  text: z.string().trim().max(50_000).optional().default(""),
  attachments: z.array(WebChatAttachment).optional(),
});

const ListThreadsInput = z.object({
  projectSlug: z.string().min(1),
});

const ListMessagesInput = z.object({
  projectSlug: z.string().min(1),
  threadId: z.string().min(1),
});

type WebChatWebhookResponse = z.infer<typeof WebChatWebhookResponse>;
type WebChatThreadsResponse = z.infer<typeof WebChatThreadsResponse>;
type WebChatMessagesResponse = z.infer<typeof WebChatMessagesResponse>;

export const webChatApp = new Hono<{ Bindings: CloudflareEnv; Variables: Variables }>();

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
  } catch (error) {
    logger.warn("[Web Chat] Failed to build machine forward URL", {
      machineId: machine.id,
      type: machine.type,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

async function resolveProjectAndMachine(
  c: Context<{ Bindings: CloudflareEnv; Variables: Variables }>,
  projectSlug: string,
): Promise<{
  project: typeof schema.project.$inferSelect;
  machine: typeof schema.machine.$inferSelect | null;
  user: NonNullable<NonNullable<Variables["session"]>["user"]>;
}> {
  const session = c.var.session;
  if (!session?.user) {
    throw new Error("UNAUTHORIZED");
  }

  const project = await c.var.db.query.project.findFirst({
    where: eq(schema.project.slug, projectSlug),
  });

  if (!project) {
    throw new Error("PROJECT_NOT_FOUND");
  }

  const membership = await c.var.db.query.organizationUserMembership.findFirst({
    where: and(
      eq(schema.organizationUserMembership.organizationId, project.organizationId),
      eq(schema.organizationUserMembership.userId, session.user.id),
    ),
  });

  if (!membership && session.user.role !== "admin") {
    throw new Error("FORBIDDEN");
  }

  const machine = await c.var.db.query.machine.findFirst({
    where: and(eq(schema.machine.projectId, project.id), eq(schema.machine.state, "active")),
  });

  return {
    project,
    machine: machine ?? null,
    user: session.user,
  };
}

export async function forwardWebChatWebhookToMachine(
  machine: typeof schema.machine.$inferSelect,
  payload: Record<string, unknown>,
  env: CloudflareEnv,
): Promise<{ success: true; data: WebChatWebhookResponse } | { success: false; error: string }> {
  const targetUrl = await buildMachineForwardUrl(
    machine,
    "/api/integrations/web-chat/webhook",
    env,
  );
  if (!targetUrl) {
    return { success: false, error: "Could not build forward URL" };
  }

  try {
    const response = await fetch(targetUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(120000),
    });

    if (!response.ok) {
      return { success: false, error: `HTTP ${response.status}` };
    }

    const parsed = WebChatWebhookResponse.safeParse(await response.json());
    if (!parsed.success) {
      return { success: false, error: "Invalid webhook response from machine daemon" };
    }

    return { success: true, data: parsed.data };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function listWebChatThreadsFromMachine(
  machine: typeof schema.machine.$inferSelect,
  env: CloudflareEnv,
): Promise<{ success: true; data: WebChatThreadsResponse } | { success: false; error: string }> {
  const targetUrl = await buildMachineForwardUrl(
    machine,
    "/api/integrations/web-chat/threads",
    env,
  );
  if (!targetUrl) {
    return { success: false, error: "Could not build forward URL" };
  }

  try {
    const response = await fetch(targetUrl, {
      method: "GET",
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) {
      return { success: false, error: `HTTP ${response.status}` };
    }

    const parsed = WebChatThreadsResponse.safeParse(await response.json());
    if (!parsed.success) {
      return { success: false, error: "Invalid threads response from machine daemon" };
    }

    return { success: true, data: parsed.data };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function listWebChatMessagesFromMachine(
  machine: typeof schema.machine.$inferSelect,
  threadId: string,
  env: CloudflareEnv,
): Promise<{ success: true; data: WebChatMessagesResponse } | { success: false; error: string }> {
  const targetUrl = await buildMachineForwardUrl(
    machine,
    `/api/integrations/web-chat/threads/${encodeURIComponent(threadId)}/messages`,
    env,
  );
  if (!targetUrl) {
    return { success: false, error: "Could not build forward URL" };
  }

  try {
    const response = await fetch(targetUrl, {
      method: "GET",
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) {
      return { success: false, error: `HTTP ${response.status}` };
    }

    const parsed = WebChatMessagesResponse.safeParse(await response.json());
    if (!parsed.success) {
      return { success: false, error: "Invalid messages response from machine daemon" };
    }

    return { success: true, data: parsed.data };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

webChatApp.post("/webhook", async (c) => {
  const parsedInput = WebhookInput.safeParse(await c.req.json());
  if (!parsedInput.success) {
    return c.json({ error: "Invalid request body", issues: parsedInput.error.issues }, 400);
  }

  try {
    const { project, machine, user } = await resolveProjectAndMachine(
      c,
      parsedInput.data.projectSlug,
    );
    if (!machine) {
      return c.json({ error: "No active machine for this project" }, 409);
    }

    const payload = {
      type: "web-chat:message",
      threadId: parsedInput.data.threadId,
      messageId: parsedInput.data.messageId ?? crypto.randomUUID(),
      text: parsedInput.data.text,
      userId: user.id,
      userName: user.name ?? user.email,
      projectId: project.id,
      projectSlug: project.slug,
      attachments: parsedInput.data.attachments,
      createdAt: Date.now(),
    } satisfies Record<string, unknown>;

    const forwarded = await forwardWebChatWebhookToMachine(machine, payload, c.env);
    if (!forwarded.success) {
      logger.error("[Web Chat] Failed to forward webhook to machine", {
        projectId: project.id,
        machineId: machine.id,
        error: forwarded.error,
      });
      return c.json({ error: forwarded.error }, 502);
    }

    return c.json(forwarded.data);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (message === "UNAUTHORIZED") {
      return c.json({ error: "Unauthorized" }, 401);
    }
    if (message === "PROJECT_NOT_FOUND") {
      return c.json({ error: "Project not found" }, 404);
    }
    if (message === "FORBIDDEN") {
      return c.json({ error: "Forbidden" }, 403);
    }

    logger.error("[Web Chat] Unexpected webhook error", error);
    return c.json({ error: "Internal server error" }, 500);
  }
});

webChatApp.get("/threads", async (c) => {
  const parsedInput = ListThreadsInput.safeParse({
    projectSlug: c.req.query("projectSlug"),
  });
  if (!parsedInput.success) {
    return c.json({ error: "Invalid query parameters", issues: parsedInput.error.issues }, 400);
  }

  try {
    const { machine } = await resolveProjectAndMachine(c, parsedInput.data.projectSlug);
    if (!machine) {
      return c.json({ threads: [] });
    }

    const response = await listWebChatThreadsFromMachine(machine, c.env);
    if (!response.success) {
      return c.json({ error: response.error }, 502);
    }

    return c.json(response.data);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (message === "UNAUTHORIZED") {
      return c.json({ error: "Unauthorized" }, 401);
    }
    if (message === "PROJECT_NOT_FOUND") {
      return c.json({ error: "Project not found" }, 404);
    }
    if (message === "FORBIDDEN") {
      return c.json({ error: "Forbidden" }, 403);
    }

    logger.error("[Web Chat] Unexpected list threads error", error);
    return c.json({ error: "Internal server error" }, 500);
  }
});

webChatApp.get("/threads/:threadId/messages", async (c) => {
  const parsedInput = ListMessagesInput.safeParse({
    projectSlug: c.req.query("projectSlug"),
    threadId: c.req.param("threadId"),
  });
  if (!parsedInput.success) {
    return c.json({ error: "Invalid query parameters", issues: parsedInput.error.issues }, 400);
  }

  try {
    const { machine } = await resolveProjectAndMachine(c, parsedInput.data.projectSlug);
    if (!machine) {
      return c.json({ threadId: parsedInput.data.threadId, messages: [] });
    }

    const response = await listWebChatMessagesFromMachine(
      machine,
      parsedInput.data.threadId,
      c.env,
    );
    if (!response.success) {
      return c.json({ error: response.error }, 502);
    }

    return c.json(response.data);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (message === "UNAUTHORIZED") {
      return c.json({ error: "Unauthorized" }, 401);
    }
    if (message === "PROJECT_NOT_FOUND") {
      return c.json({ error: "Project not found" }, 404);
    }
    if (message === "FORBIDDEN") {
      return c.json({ error: "Forbidden" }, 403);
    }

    logger.error("[Web Chat] Unexpected list messages error", error);
    return c.json({ error: "Internal server error" }, 500);
  }
});
