import { homedir } from "node:os";
import { Hono } from "hono";
import { createOpencodeClient } from "@opencode-ai/sdk";
import type { IterateEvent } from "../types/events.ts";
import { isPromptEvent } from "../types/events.ts";
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
  return events
    .filter(isPromptEvent)
    .map((e) => e.message)
    .join("\n\n");
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
  const eventList = Array.isArray(events) ? events : [];

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

opencodeRouter.post("/sessions/:sessionId", async (c) => {
  const sessionId = c.req.param("sessionId");
  const payload = await c.req.json();
  const events: IterateEvent[] = Array.isArray(payload) ? payload : [payload];

  // Concatenate all events into one prompt
  const combinedPrompt = concatenatePrompts(events);
  if (combinedPrompt) {
    await sendPromptToSession(sessionId, combinedPrompt, getOpencodeWorkingDirectory());
  }

  return c.json({ success: true, sessionId });
});
