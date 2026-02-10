import { homedir } from "node:os";
import { Hono } from "hono";
import { stream } from "hono/streaming";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { createOpencodeClient } from "@opencode-ai/sdk";
import { eq } from "drizzle-orm";
import { db } from "../db/index.ts";
import * as schema from "../db/schema.ts";
import { notifyAgentChange } from "../services/agent-change-callbacks.ts";
import type { IterateEvent } from "../types/events.ts";
import { extractIterateEvents } from "../types/events.ts";
import { getAgentWorkingDirectory } from "../utils/agent-working-directory.ts";

// Opencode sessions are project-bound - use homedir as neutral location for global sessions
function getOpencodeWorkingDirectory(): string {
  const dir = getAgentWorkingDirectory();
  // If it's the default fallback (cwd), use homedir instead for global accessibility
  if (dir === process.cwd()) {
    return homedir();
  }
  return dir;
}

const OPENCODE_BASE_URL = process.env.OPENCODE_BASE_URL ?? "http://localhost:4096";

export const opencodeRouter = new Hono();

type TrackedAgentPath = {
  agentPath: string;
  harnessHandle: string;
};

const trackedByAgentPath = new Map<string, TrackedAgentPath>();
const agentPathByHarnessHandle = new Map<string, Set<string>>();

let lifecycleSubscriptionStarted = false;

/** Concatenate all prompt events into a single message */
function concatenatePrompts(events: IterateEvent[]): string {
  return events.map((e) => e.message).join("\n\n");
}

async function sendPromptToSession(
  sessionId: string,
  prompt: string,
  workingDirectory: string,
): Promise<void> {
  const client = createOpencodeClient({ baseUrl: OPENCODE_BASE_URL });
  await client.session.prompt({
    path: { id: sessionId },
    query: { directory: workingDirectory },
    body: { parts: [{ type: "text", text: prompt }] },
  });
}

opencodeRouter.post("/new", async (c) => {
  const { agentPath, events } = (await c.req.json()) as {
    agentPath: string;
    events?: IterateEvent[];
  };

  const client = createOpencodeClient({ baseUrl: OPENCODE_BASE_URL });
  const workingDirectory = getOpencodeWorkingDirectory();
  const response = await client.session.create({
    query: { directory: workingDirectory },
    body: { title: `Agent: ${agentPath}` },
  });

  if (!response.data) {
    return c.json({ error: "Failed to create session" }, 500);
  }

  const sessionId = response.data.id;
  const eventList = extractIterateEvents(events);

  // Concatenate all events into one prompt
  const combinedPrompt = concatenatePrompts(eventList);
  if (combinedPrompt) {
    await sendPromptToSession(sessionId, combinedPrompt, workingDirectory);
    await trackAgentLifecycle({ agentPath, harnessHandle: sessionId });
  }

  return c.json({
    route: `/opencode/sessions/${sessionId}`,
    sessionId,
    workingDirectory,
    tui: `opencode attach ${OPENCODE_BASE_URL} -s ${sessionId}`,
  });
});

opencodeRouter.get("/sessions/:sessionId", async (c) => {
  const sessionId = c.req.param("sessionId");

  // Prefer direct session-scoped event stream when available.
  const directResponse = await fetch(`${OPENCODE_BASE_URL}/session/${sessionId}/event`, {
    method: "GET",
    headers: { Accept: "text/event-stream" },
  }).catch(() => null);

  if (directResponse?.ok && directResponse.body) {
    c.status(directResponse.status as ContentfulStatusCode);
    c.header("content-type", directResponse.headers.get("content-type") ?? "text/event-stream");
    c.header("cache-control", "no-cache");
    return stream(c, async (streamWriter) => {
      const reader = directResponse.body!.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          await streamWriter.write(value);
        }
      } finally {
        reader.releaseLock();
      }
    });
  }

  // Fallback: proxy global stream and filter events to this session.
  const globalResponse = await fetch(`${OPENCODE_BASE_URL}/global/event`, {
    method: "GET",
    headers: { Accept: "text/event-stream" },
  });

  if (!globalResponse.ok || !globalResponse.body) {
    return c.json({ error: "Failed to subscribe to opencode events", sessionId }, 502);
  }

  c.header("content-type", "text/event-stream");
  c.header("cache-control", "no-cache");
  c.header("connection", "keep-alive");

  return stream(c, async (streamWriter) => {
    const reader = globalResponse.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        let boundary = buffer.indexOf("\n\n");
        while (boundary !== -1) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);

          const dataLines = frame
            .split("\n")
            .map((line) => line.trimEnd())
            .filter((line) => line.startsWith("data:"));
          const payload = dataLines.map((line) => line.slice(5).trimStart()).join("\n");

          if (payload && payload !== "[DONE]") {
            try {
              const parsed = JSON.parse(payload) as Record<string, unknown>;
              if (extractSessionId(parsed) === sessionId) {
                await streamWriter.write(`data: ${JSON.stringify(parsed)}\n\n`);
              }
            } catch {
              // Ignore non-JSON payloads in fallback mode.
            }
          }

          boundary = buffer.indexOf("\n\n");
        }
      }
    } finally {
      reader.releaseLock();
    }
  });
});

opencodeRouter.post("/sessions/:sessionId", async (c) => {
  const sessionId = c.req.param("sessionId");
  const agentPathFromHeader = c.req.header("x-iterate-agent-path") ?? undefined;
  const payload = await c.req.json();
  const events = extractIterateEvents(payload);

  // Concatenate all events into one prompt
  const combinedPrompt = concatenatePrompts(events);
  if (combinedPrompt) {
    await sendPromptToSession(sessionId, combinedPrompt, getOpencodeWorkingDirectory());
    await trackAgentLifecycle({ agentPath: agentPathFromHeader, harnessHandle: sessionId });
  }

  return c.json({ success: true, sessionId });
});

function ensureLifecycleSubscription(): void {
  if (lifecycleSubscriptionStarted) return;
  lifecycleSubscriptionStarted = true;
  void runLifecycleSubscriptionLoop();
}

async function runLifecycleSubscriptionLoop(): Promise<void> {
  while (true) {
    try {
      const globalResponse = await fetch(`${OPENCODE_BASE_URL}/global/event`, {
        method: "GET",
        headers: { Accept: "text/event-stream" },
      });

      if (!globalResponse.ok || !globalResponse.body) {
        await sleepMs(1000);
        continue;
      }

      const reader = globalResponse.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          let boundary = buffer.indexOf("\n\n");
          while (boundary !== -1) {
            const frame = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            await handleLifecycleFrame(frame);
            boundary = buffer.indexOf("\n\n");
          }
        }
      } finally {
        reader.releaseLock();
      }
    } catch {
      // Keep lifecycle handling best-effort; we'll reconnect below.
    }

    await sleepMs(1000);
  }
}

async function handleLifecycleFrame(frame: string): Promise<void> {
  const dataLines = frame
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.startsWith("data:"));
  if (dataLines.length === 0) return;

  const payload = dataLines.map((line) => line.slice(5).trimStart()).join("\n");
  if (!payload || payload === "[DONE]") return;

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(payload) as Record<string, unknown>;
  } catch {
    return;
  }

  const harnessHandle = extractSessionId(parsed);
  if (!harnessHandle) return;

  const agentPaths = agentPathByHarnessHandle.get(harnessHandle);
  if (!agentPaths || agentPaths.size === 0) return;

  const type = typeof parsed.type === "string" ? parsed.type : "";
  if (type === "session.idle" || type === "session.error" || isIdleStatusEvent(parsed)) {
    for (const agentPath of agentPaths) {
      await settleAgentPath(agentPath);
    }
    return;
  }

  const statusEvent = extractToolStatusEvent(parsed);
  if (!statusEvent) return;

  for (const agentPath of agentPaths) {
    await updateAgentLifecycleState(agentPath, {
      isWorking: true,
      shortStatus: statusEvent.statusText,
    });
  }
}

function isIdleStatusEvent(event: Record<string, unknown>): boolean {
  if (event.type !== "session.status") return false;
  const properties = asRecord(event.properties);
  const status = asRecord(properties?.status);
  return status?.type === "idle";
}

function extractToolStatusEvent(event: Record<string, unknown>): {
  statusText: string;
} | null {
  if (event.type !== "message.part.updated") return null;
  const properties = asRecord(event.properties);
  const part = asRecord(properties?.part);
  if (!part || part.type !== "tool") return null;

  const state = asRecord(part.state);
  if (!state) return null;
  const stateStatus = typeof state.status === "string" ? state.status : "";
  if (stateStatus !== "running" && stateStatus !== "completed") return null;

  const input = asRecord(state.input) ?? {};
  const title = typeof state.title === "string" ? state.title : "";
  const description = typeof input.description === "string" ? input.description : "";
  const tool = typeof part.tool === "string" ? part.tool : "";
  const statusText = (title || description || tool || "Working").slice(0, 30);

  return {
    statusText,
  };
}

async function settleAgentPath(agentPath: string): Promise<void> {
  const tracked = trackedByAgentPath.get(agentPath);
  if (!tracked) return;

  trackedByAgentPath.delete(agentPath);
  const set = agentPathByHarnessHandle.get(tracked.harnessHandle);
  if (set) {
    set.delete(agentPath);
    if (set.size === 0) {
      agentPathByHarnessHandle.delete(tracked.harnessHandle);
    }
  }

  await updateAgentLifecycleState(agentPath, {
    isWorking: false,
    shortStatus: "",
  });
}

export async function trackAgentLifecycle(params: {
  agentPath?: string;
  harnessHandle: string;
}): Promise<void> {
  const agentPath =
    params.agentPath ?? (await resolveAgentPathByHarnessHandle(params.harnessHandle));
  if (!agentPath) return;

  ensureLifecycleSubscription();

  const existing = trackedByAgentPath.get(agentPath);
  if (!existing || existing.harnessHandle !== params.harnessHandle) {
    if (existing) {
      await settleAgentPath(agentPath);
    }
    trackedByAgentPath.set(agentPath, {
      agentPath,
      harnessHandle: params.harnessHandle,
    });
    const set = agentPathByHarnessHandle.get(params.harnessHandle) ?? new Set<string>();
    set.add(agentPath);
    agentPathByHarnessHandle.set(params.harnessHandle, set);
    await updateAgentLifecycleState(agentPath, {
      isWorking: true,
      shortStatus: "Working",
    });
  }
}

async function sleepMs(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function resolveAgentPathByHarnessHandle(harnessHandle: string): Promise<string | null> {
  const activeRoutes = await db
    .select()
    .from(schema.agentRoutes)
    .where(eq(schema.agentRoutes.active, true));

  for (const route of activeRoutes) {
    const metadata = (route.metadata ?? null) as Record<string, unknown> | null;
    if (!metadata) continue;
    const maybeHarnessHandle =
      metadata.harnessHandle ?? metadata.providerHandle ?? metadata.sessionId;
    if (maybeHarnessHandle === harnessHandle) {
      return route.agentPath;
    }
  }

  return null;
}

async function updateAgentLifecycleState(
  agentPath: string,
  params: { isWorking?: boolean; shortStatus?: string },
): Promise<void> {
  const setValues: Partial<typeof schema.agents.$inferInsert> = {
    updatedAt: new Date(),
  };
  if (params.isWorking !== undefined) setValues.isWorking = params.isWorking;
  if (params.shortStatus !== undefined) setValues.shortStatus = params.shortStatus;
  await db.update(schema.agents).set(setValues).where(eq(schema.agents.path, agentPath));
  await notifyAgentChange(agentPath);
}

function extractSessionId(event: Record<string, unknown>): string | null {
  if (
    event.type === "session.status" ||
    event.type === "session.idle" ||
    event.type === "session.error"
  ) {
    const properties = asRecord(event.properties);
    return typeof properties?.sessionID === "string" ? properties.sessionID : null;
  }

  if (event.type === "message.updated") {
    const properties = asRecord(event.properties);
    const info = asRecord(properties?.info);
    return typeof info?.sessionID === "string" ? info.sessionID : null;
  }

  if (event.type === "message.part.updated") {
    const properties = asRecord(event.properties);
    const part = asRecord(properties?.part);
    return typeof part?.sessionID === "string" ? part.sessionID : null;
  }

  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}
