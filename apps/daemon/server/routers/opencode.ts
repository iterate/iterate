import { homedir } from "node:os";
import { Hono } from "hono";
import { stream } from "hono/streaming";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { createOpencodeClient, type Event as OpencodeEvent, type ToolPart } from "@opencode-ai/sdk";
import { eq } from "drizzle-orm";
import { db } from "../db/index.ts";
import * as schema from "../db/schema.ts";
import { isPromptEvent } from "../types/events.ts";
import { getAgentWorkingDirectory } from "../utils/agent-working-directory.ts";
import { trpcRouter } from "../trpc/router.ts";
import { withSpan } from "../utils/otel.ts";

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
const trpc = trpcRouter.createCaller({});

export const opencodeRouter = new Hono();

type TrackedAgentPath = {
  agentPath: string;
  harnessHandle: string;
};

const trackedByAgentPath = new Map<string, TrackedAgentPath>();
const agentPathByHarnessHandle = new Map<string, Set<string>>();

let lifecycleSubscriptionStarted = false;

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
  const { agentPath } = (await c.req.json()) as { agentPath: string };

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
  const agentPath = c.req.header("x-iterate-agent-path") ?? undefined;
  const payload = await c.req.json();

  if (!isPromptEvent(payload)) {
    return c.json({ error: "Expected a prompt event" }, 400);
  }

  const { message } = payload;

  // Fire-and-forget: background the prompt so the caller returns immediately
  void withSpan(
    "daemon.opencode.append",
    {
      attributes: {
        "opencode.session_id": sessionId,
        ...(agentPath ? { "agent.path": agentPath } : {}),
        "prompt.length": message.length,
      },
    },
    async () => {
      await trackAgentLifecycle({ agentPath, harnessHandle: sessionId });
      await sendPromptToSession(sessionId, message, getOpencodeWorkingDirectory());
    },
  ).catch((error) => {
    console.error("[opencode] background prompt failed", {
      sessionId,
      agentPath,
      error: error instanceof Error ? error.message : String(error),
    });
  });

  return c.json({ success: true, sessionId });
});

// ---------------------------------------------------------------------------
// Lifecycle subscription via OpenCode SDK global event stream
// ---------------------------------------------------------------------------
//
// We subscribe once to `client.global.event()` and dispatch typed events
// to tracked agent paths. Only two signals matter:
//   1. idle / error  -> mark agent not working, clear status
//   2. tool running/completed -> update shortStatus

function ensureLifecycleSubscription(): void {
  if (lifecycleSubscriptionStarted) return;
  lifecycleSubscriptionStarted = true;
  void startLifecycleSubscription();
}

async function startLifecycleSubscription(): Promise<void> {
  const client = createOpencodeClient({ baseUrl: OPENCODE_BASE_URL });
  const result = await client.global.event();

  for await (const globalEvent of result.stream) {
    const event = globalEvent.payload;
    const sessionId = extractSessionIdFromEvent(event);
    if (!sessionId) continue;

    const agentPaths = agentPathByHarnessHandle.get(sessionId);
    if (!agentPaths || agentPaths.size === 0) continue;

    // Idle / error -> settle (mark not working)
    if (
      event.type === "session.idle" ||
      event.type === "session.error" ||
      (event.type === "session.status" && event.properties.status.type === "idle")
    ) {
      for (const agentPath of agentPaths) await settleAgentPath(agentPath);
      continue;
    }

    // Tool status updates
    if (event.type === "message.part.updated" && event.properties.part.type === "tool") {
      const statusText = extractToolStatusText(event.properties.part);
      if (!statusText) continue;
      for (const agentPath of agentPaths) {
        await trpc.updateAgent({ path: agentPath, isWorking: true, shortStatus: statusText });
      }
    }
  }
}

/** Extract a human-readable status string from a tool part in running/completed state. */
function extractToolStatusText(part: ToolPart): string | null {
  const { state } = part;
  if (state.status !== "running" && state.status !== "completed") return null;

  const title = "title" in state && typeof state.title === "string" ? state.title : "";
  const description =
    state.input && typeof state.input.description === "string" ? state.input.description : "";
  return (title || description || part.tool || "Working").slice(0, 30);
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

  await trpc.updateAgent({ path: agentPath, isWorking: false, shortStatus: "" });
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
    await trpc.updateAgent({ path: agentPath, isWorking: true, shortStatus: "Working" });
  }
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

// ---------------------------------------------------------------------------
// Session ID extraction from raw events (used by the GET stream proxy)
// ---------------------------------------------------------------------------

function extractSessionIdFromEvent(event: OpencodeEvent): string | null {
  switch (event.type) {
    case "session.status":
    case "session.idle":
      return event.properties.sessionID;
    case "session.error":
      return event.properties.sessionID ?? null;
    case "message.updated":
      return event.properties.info.sessionID;
    case "message.part.updated":
      return event.properties.part.sessionID;
    default:
      return null;
  }
}

/** Extract session ID from untyped event record (used for raw SSE proxy filtering). */
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
