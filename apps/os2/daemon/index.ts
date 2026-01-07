import * as fs from "fs";
import * as path from "path";
import * as YAML from "yaml";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { streamSSE } from "hono/streaming";
import type { Agent, Message, SlackWebhook } from "./types.ts";
import {
  createPiSession,
  disposePiSession,
  promptPiSession,
  setAppendMessage,
  type PiStreamMessage,
} from "./pi/index.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Store (in-memory + YAML persistence)
// ─────────────────────────────────────────────────────────────────────────────

const STORAGE_DIR = new URL("./.iterate", import.meta.url).pathname;
const agents = new Map<string, Agent>();

interface StreamData {
  id: string;
  contentType: string;
  createdAt: string;
  messages: Message[];
}

function getStreamPath(id: string): string {
  const safeId = id.replace(/[^a-zA-Z0-9_-]/g, "_");
  return path.join(STORAGE_DIR, `${safeId}.yaml`);
}

function loadStreamFromDisk(id: string): StreamData | undefined {
  const filePath = getStreamPath(id);
  if (!fs.existsSync(filePath)) return undefined;
  return YAML.parse(fs.readFileSync(filePath, "utf-8"), { maxAliasCount: -1 });
}

function saveStreamToDisk(agent: Agent): void {
  fs.mkdirSync(STORAGE_DIR, { recursive: true });
  const data: StreamData = {
    id: agent.id,
    contentType: agent.contentType,
    createdAt: agent.createdAt,
    messages: agent.messages,
  };
  fs.writeFileSync(getStreamPath(agent.id), YAML.stringify(data), "utf-8");
}

function deleteStreamFromDisk(id: string): void {
  const filePath = getStreamPath(id);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

function initializeStore(): void {
  fs.mkdirSync(STORAGE_DIR, { recursive: true });

  const streamIds = fs.existsSync(STORAGE_DIR)
    ? fs
        .readdirSync(STORAGE_DIR)
        .filter((f) => f.endsWith(".yaml"))
        .map((f) => f.replace(/\.yaml$/, ""))
    : [];

  for (const id of streamIds) {
    const data = loadStreamFromDisk(id);
    if (data) {
      agents.set(id, {
        id: data.id,
        contentType: data.contentType,
        createdAt: data.createdAt,
        messages: data.messages,
        subscribers: new Set(),
        nextOffset: data.messages.length,
      });
    }
  }

  console.log(`Loaded ${streamIds.length} streams from disk`);
}

function getAgent(id: string): Agent | undefined {
  return agents.get(id);
}

async function createAgent(
  id: string,
  contentType = "application/json",
  options: { createPiSession?: boolean } = { createPiSession: true },
): Promise<Agent> {
  const existing = agents.get(id);
  if (existing) return existing;

  const agent: Agent = {
    id,
    contentType,
    createdAt: new Date().toISOString(),
    messages: [],
    subscribers: new Set(),
    nextOffset: 0,
  };

  if (options.createPiSession && !id.startsWith("__")) {
    try {
      agent.piSession = await createPiSession(id);
      console.log(`Created Pi session for agent: ${id}`);
    } catch (error) {
      console.error(`Failed to create Pi session for ${id}:`, error);
    }
  }

  agents.set(id, agent);
  saveStreamToDisk(agent);
  return agent;
}

function deleteAgent(id: string): void {
  const agent = agents.get(id);
  if (!agent) return;

  if (agent.piSession) {
    try {
      disposePiSession(agent.piSession);
    } catch (error) {
      console.error(`Failed to dispose Pi session for ${id}:`, error);
    }
  }

  for (const controller of agent.subscribers) {
    try {
      controller.close?.();
    } catch {}
  }

  agents.delete(id);
  deleteStreamFromDisk(id);
}

async function appendMessage(
  agentId: string,
  content: unknown,
  source: string,
  metadata: Record<string, unknown> = {},
): Promise<Message> {
  const agent = agents.get(agentId) ?? (await createAgent(agentId));

  const message: Message = {
    offset: String(agent.nextOffset++),
    content,
    timestamp: new Date().toISOString(),
    source,
    metadata,
  };

  agent.messages.push(message);

  // Skip persisting message_update events (streaming deltas)
  if ((content as Record<string, unknown>)?.type !== "message_update") {
    saveStreamToDisk(agent);
  }

  // Notify subscribers
  for (const controller of agent.subscribers) {
    try {
      controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(message)}\n\n`));
    } catch {
      agent.subscribers.delete(controller);
    }
  }

  return message;
}

function getMessagesFromOffset(agentId: string, offset: string): Message[] {
  const agent = agents.get(agentId);
  if (!agent) return [];
  if (offset === "-1") return agent.messages;
  const offsetNum = parseInt(offset, 10);
  if (isNaN(offsetNum)) return [];
  return agent.messages.filter((m) => parseInt(m.offset, 10) > offsetNum);
}

function subscribe(agentId: string, controller: ReadableStreamDefaultController): void {
  agents.get(agentId)?.subscribers.add(controller);
}

function unsubscribe(agentId: string, controller: ReadableStreamDefaultController): void {
  agents.get(agentId)?.subscribers.delete(controller);
}

// ─────────────────────────────────────────────────────────────────────────────
// Registry (tracks stream create/delete for UI)
// ─────────────────────────────────────────────────────────────────────────────

const REGISTRY_STREAM = "__registry__";

async function onStreamCreated(path: string, contentType: string): Promise<void> {
  if (!getAgent(REGISTRY_STREAM)) await createAgent(REGISTRY_STREAM, "application/json");
  await appendMessage(
    REGISTRY_STREAM,
    {
      type: "stream",
      key: path,
      value: { path, contentType, createdAt: Date.now() },
      headers: { operation: "insert" },
    },
    "system",
  );
}

async function onStreamDeleted(path: string): Promise<void> {
  if (!getAgent(REGISTRY_STREAM)) await createAgent(REGISTRY_STREAM, "application/json");
  await appendMessage(
    REGISTRY_STREAM,
    {
      type: "stream",
      key: path,
      headers: { operation: "delete" },
    },
    "system",
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Initialize
// ─────────────────────────────────────────────────────────────────────────────

initializeStore();

// Inject appendMessage into Pi modules (avoids circular dependency)
setAppendMessage(appendMessage);

// ─────────────────────────────────────────────────────────────────────────────
// HTTP Server
// ─────────────────────────────────────────────────────────────────────────────

const app = new Hono();

app.use("*", logger());
app.use(
  "*",
  cors({
    origin: "*",
    allowMethods: ["GET", "POST", "PUT", "DELETE", "HEAD", "OPTIONS"],
    allowHeaders: [
      "Content-Type",
      "Authorization",
      "Stream-Seq",
      "Stream-TTL",
      "Stream-Expires-At",
    ],
    exposeHeaders: [
      "Stream-Next-Offset",
      "Stream-Cursor",
      "Stream-Up-To-Date",
      "ETag",
      "Content-Type",
      "Content-Encoding",
      "Vary",
      "Location",
    ],
  }),
);

app.get("/", (c) => c.redirect("/ui"));
app.get("/platform/ping", (c) => c.text("PONG"));

// Slack webhook
app.post("/edge/slack", async (c) => {
  let webhook: SlackWebhook;
  try {
    webhook = await c.req.json();
  } catch {
    return c.text("Invalid JSON", 400);
  }
  const event = webhook.event;
  if (!event) return c.text("OK");
  const threadId = event.thread_ts ?? event.ts;
  if (!threadId) return c.text("Missing thread identifier", 400);
  appendMessage(threadId, webhook, "slack", { channel: event.channel, user: event.user });
  return c.text("OK");
});

// ─────────────────────────────────────────────────────────────────────────────
// Agent Stream Routes
// ─────────────────────────────────────────────────────────────────────────────

const STREAM_OFFSET_HEADER = "Stream-Next-Offset";

function getCurrentOffset(streamPath: string): string {
  const agent = getAgent(streamPath);
  return agent?.messages.length ? agent.messages[agent.messages.length - 1].offset : "0";
}

app.put("/agents/*", async (c) => {
  const streamPath = c.req.path.replace("/agents/", "");
  const contentType = c.req.header("content-type") || "application/json";
  const isNew = !getAgent(streamPath);
  await createAgent(streamPath, contentType);
  if (isNew && !streamPath.startsWith("__")) await onStreamCreated(streamPath, contentType);
  return new Response(null, {
    status: isNew ? 201 : 200,
    headers: {
      [STREAM_OFFSET_HEADER]: getCurrentOffset(streamPath),
      ...(isNew && { Location: c.req.url }),
      "Content-Type": contentType,
    },
  });
});

app.on("HEAD", "/agents/*", (c) => {
  const streamPath = c.req.path.replace("/agents/", "");
  const agent = getAgent(streamPath);
  if (!agent) return new Response("Stream not found", { status: 404 });
  return new Response(null, {
    status: 200,
    headers: {
      [STREAM_OFFSET_HEADER]: getCurrentOffset(streamPath),
      "Content-Type": agent.contentType,
    },
  });
});

app.post("/agents/*", async (c) => {
  const streamPath = c.req.path.replace("/agents/", "");
  const contentType = c.req.header("content-type");
  if (!contentType) return c.text("Content-Type header is required", 400);

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.text("Invalid JSON", 400);
  }

  const isNew = !getAgent(streamPath);
  if (isNew) {
    await createAgent(streamPath, contentType);
    if (!streamPath.startsWith("__")) await onStreamCreated(streamPath, contentType);
  }

  const agent = getAgent(streamPath)!;

  // Lazily create Pi session for agents loaded from disk that don't have one yet
  if (!agent.piSession && !streamPath.startsWith("__")) {
    try {
      agent.piSession = await createPiSession(streamPath);
      console.log(`Lazily created Pi session for agent: ${streamPath}`);
    } catch (error) {
      console.error(`Failed to lazily create Pi session for ${streamPath}:`, error);
    }
  }

  if (agent.piSession) {
    let promptText: string;
    if (typeof body === "string") promptText = body;
    else if (typeof body === "object" && body !== null) {
      const obj = body as Record<string, unknown>;
      promptText = String(obj.text ?? obj.message ?? obj.prompt ?? JSON.stringify(body));
    } else promptText = String(body);

    const userMessage = await appendMessage(
      streamPath,
      { type: "user_prompt", text: promptText } satisfies PiStreamMessage,
      "user",
    );

    promptPiSession(agent.piSession, promptText).catch((error) => {
      console.error(`Pi prompt error for ${streamPath}:`, error);
      appendMessage(
        streamPath,
        {
          type: "error",
          message: error instanceof Error ? error.message : String(error),
        } satisfies PiStreamMessage,
        "system",
      );
    });

    return new Response(null, {
      status: 200,
      headers: { [STREAM_OFFSET_HEADER]: userMessage.offset },
    });
  }

  const message = await appendMessage(streamPath, body, "direct");
  return new Response(null, { status: 200, headers: { [STREAM_OFFSET_HEADER]: message.offset } });
});

app.get("/agents/*", (c) => {
  const streamPath = c.req.path.replace("/agents/", "");
  const offset = c.req.query("offset") ?? "-1";
  const live = c.req.query("live");
  const agent = getAgent(streamPath);

  if (!agent) return c.text("Stream not found", 404);
  if (live === "sse" && !c.req.query("offset")) return c.text("SSE requires offset parameter", 400);

  const existingMessages = getMessagesFromOffset(streamPath, offset);

  if (live === "sse") {
    return streamSSE(c, async (stream) => {
      for (const message of existingMessages) {
        await stream.writeSSE({ event: "data", data: JSON.stringify([message.content]) });
      }

      const currentOffset =
        existingMessages.length > 0
          ? existingMessages[existingMessages.length - 1].offset
          : getCurrentOffset(streamPath);
      await stream.writeSSE({
        event: "control",
        data: JSON.stringify({ streamNextOffset: currentOffset, upToDate: true }),
      });

      let lastOffset = currentOffset;
      const controller = {
        enqueue: (chunk: Uint8Array) => {
          const text = new TextDecoder().decode(chunk);
          const match = text.match(/^data: (.+)\n\n$/s);
          if (match) {
            try {
              const msg = JSON.parse(match[1]) as Message;
              stream.writeSSE({ event: "data", data: JSON.stringify([msg.content]) });
              lastOffset = msg.offset;
              stream.writeSSE({
                event: "control",
                data: JSON.stringify({ streamNextOffset: lastOffset, upToDate: true }),
              });
            } catch {}
          }
        },
      } as ReadableStreamDefaultController;

      subscribe(streamPath, controller);
      await new Promise<void>((resolve) => {
        c.req.raw.signal.addEventListener("abort", () => {
          unsubscribe(streamPath, controller);
          resolve();
        });
      });
    });
  }

  const currentOffset =
    existingMessages.length > 0
      ? existingMessages[existingMessages.length - 1].offset
      : getCurrentOffset(streamPath);
  return new Response(JSON.stringify(existingMessages.map((m) => m.content)), {
    status: 200,
    headers: {
      "Content-Type": agent.contentType,
      [STREAM_OFFSET_HEADER]: currentOffset,
      "Stream-Up-To-Date": "true",
    },
  });
});

app.delete("/agents/*", async (c) => {
  const streamPath = c.req.path.replace("/agents/", "");
  if (!getAgent(streamPath)) return c.text("Stream not found", 404);
  deleteAgent(streamPath);
  if (!streamPath.startsWith("__")) await onStreamDeleted(streamPath);
  return new Response(null, { status: 204 });
});

export default app;
