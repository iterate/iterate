import { homedir } from "node:os";
import { Hono } from "hono";
import { stream } from "hono/streaming";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { createOpencodeClient } from "@opencode-ai/sdk";
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
  const payload = await c.req.json();
  const events = extractIterateEvents(payload);

  // Concatenate all events into one prompt
  const combinedPrompt = concatenatePrompts(events);
  if (combinedPrompt) {
    await sendPromptToSession(sessionId, combinedPrompt, getOpencodeWorkingDirectory());
  }

  return c.json({ success: true, sessionId });
});

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
