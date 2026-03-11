import { Hono, type Context } from "hono";
import { and, eq } from "drizzle-orm";
import { z } from "zod/v4";
import { createMachineStub } from "@iterate-com/sandbox/providers/machine-stub";
import type { CloudflareEnv } from "../../../env.ts";
import type { Variables } from "../../types.ts";
import * as schema from "../../db/schema.ts";
import { logger } from "../../tag-logger.ts";

const WebchatAttachment = z.object({
  fileName: z.string(),
  filePath: z.string(),
  mimeType: z.string().optional(),
  size: z.number().optional(),
});

const WebchatMessage = z.object({
  threadId: z.string(),
  messageId: z.string(),
  role: z.enum(["user", "assistant"]),
  text: z.string(),
  userId: z.string().optional(),
  userName: z.string().optional(),
  reactions: z.array(z.string()).optional(),
  attachments: z.array(WebchatAttachment).optional(),
  createdAt: z.number(),
});

const WebchatThread = z.object({
  threadId: z.string(),
  messageCount: z.number(),
  title: z.string(),
  lastMessagePreview: z.string(),
  lastMessageRole: z.enum(["user", "assistant"]),
  lastMessageAt: z.number(),
});

const WebchatWebhookResponse = z.object({
  success: z.boolean(),
  duplicate: z.boolean().optional(),
  threadId: z.string(),
  messageId: z.string().optional(),
  eventId: z.string().optional(),
  created: z.boolean().optional(),
});

const WebchatThreadsResponse = z.object({
  threads: z.array(WebchatThread),
});

const WebchatMessagesResponse = z.object({
  threadId: z.string(),
  messages: z.array(WebchatMessage),
  status: z.string().optional(),
});

const WebhookInput = z.object({
  projectSlug: z.string().min(1),
  threadId: z.string().min(1).optional(),
  messageId: z.string().min(1).optional(),
  text: z.string().trim().max(50_000).optional().default(""),
  attachments: z.array(WebchatAttachment).optional(),
});

const ListThreadsInput = z.object({
  projectSlug: z.string().min(1),
});

const ListMessagesInput = z.object({
  projectSlug: z.string().min(1),
  threadId: z.string().min(1),
});

type WebchatWebhookResponse = z.infer<typeof WebchatWebhookResponse>;
type WebchatThreadsResponse = z.infer<typeof WebchatThreadsResponse>;
type WebchatMessagesResponse = z.infer<typeof WebchatMessagesResponse>;

export const webchatApp = new Hono<{ Bindings: CloudflareEnv; Variables: Variables }>();

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
  } catch (error) {
    logger.warn("[webchat] Failed to build machine forward fetcher", {
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

export async function forwardWebchatWebhookToMachine(
  machine: typeof schema.machine.$inferSelect,
  payload: Record<string, unknown>,
  env: CloudflareEnv,
): Promise<{ success: true; data: WebchatWebhookResponse } | { success: false; error: string }> {
  const fetcher = await buildMachineForwardFetcher(machine, env);
  if (!fetcher) {
    return { success: false, error: "Could not build forward fetcher" };
  }

  try {
    const response = await fetcher("/api/integrations/webchat/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(120000),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "<no body>");
      logger.warn("[webchat] Webhook forward failed", {
        status: response.status,
        body: body.slice(0, 500),
      });
      return { success: false, error: `HTTP ${response.status}: ${body.slice(0, 200)}` };
    }

    const parsed = WebchatWebhookResponse.safeParse(await response.json());
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

export async function listWebchatThreadsFromMachine(
  machine: typeof schema.machine.$inferSelect,
  env: CloudflareEnv,
): Promise<{ success: true; data: WebchatThreadsResponse } | { success: false; error: string }> {
  const fetcher = await buildMachineForwardFetcher(machine, env);
  if (!fetcher) {
    return { success: false, error: "Could not build forward fetcher" };
  }

  try {
    const response = await fetcher("/api/integrations/webchat/threads", {
      method: "GET",
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) {
      return { success: false, error: `HTTP ${response.status}` };
    }

    const parsed = WebchatThreadsResponse.safeParse(await response.json());
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

export async function listWebchatMessagesFromMachine(
  machine: typeof schema.machine.$inferSelect,
  threadId: string,
  env: CloudflareEnv,
): Promise<{ success: true; data: WebchatMessagesResponse } | { success: false; error: string }> {
  const fetcher = await buildMachineForwardFetcher(machine, env);
  if (!fetcher) {
    return { success: false, error: "Could not build forward fetcher" };
  }

  try {
    const response = await fetcher(
      `/api/integrations/webchat/threads/${encodeURIComponent(threadId)}/messages`,
      {
        method: "GET",
        signal: AbortSignal.timeout(15000),
      },
    );

    if (!response.ok) {
      return { success: false, error: `HTTP ${response.status}` };
    }

    const parsed = WebchatMessagesResponse.safeParse(await response.json());
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

webchatApp.post("/webhook", async (c) => {
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
      type: "webchat:message",
      threadId: parsedInput.data.threadId,
      messageId: parsedInput.data.messageId ?? crypto.randomUUID(),
      text: parsedInput.data.text,
      userId: user.id,
      userName: user.name || user.email,
      projectId: project.id,
      projectSlug: project.slug,
      attachments: parsedInput.data.attachments,
      createdAt: Date.now(),
    } satisfies Record<string, unknown>;

    const forwarded = await forwardWebchatWebhookToMachine(machine, payload, c.env);
    if (!forwarded.success) {
      logger.error("[webchat] Failed to forward webhook to machine", {
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

    logger.error("[webchat] Unexpected webhook error", error);
    return c.json({ error: "Internal server error" }, 500);
  }
});

webchatApp.get("/threads", async (c) => {
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

    const response = await listWebchatThreadsFromMachine(machine, c.env);
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

    logger.error("[webchat] Unexpected list threads error", error);
    return c.json({ error: "Internal server error" }, 500);
  }
});

webchatApp.get("/threads/:threadId/messages", async (c) => {
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

    const response = await listWebchatMessagesFromMachine(
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

    logger.error("[webchat] Unexpected list messages error", error);
    return c.json({ error: "Internal server error" }, 500);
  }
});
