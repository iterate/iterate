import { Hono } from "hono";
import { createOpencodeClient } from "@opencode-ai/sdk";
import type { IterateEvent } from "../types/events.ts";
import { isPromptEvent } from "../types/events.ts";
import { getAgentWorkingDirectory } from "../utils/agent-working-directory.ts";

const OPENCODE_BASE_URL = process.env.OPENCODE_BASE_URL ?? "http://localhost:4096";

export const opencodeRouter = new Hono();

async function sendEventsToSession(sessionId: string, events: IterateEvent[]): Promise<void> {
  const client = createOpencodeClient({ baseUrl: OPENCODE_BASE_URL });

  for (const event of events) {
    if (!isPromptEvent(event)) continue;
    await client.session.prompt({
      path: { id: sessionId },
      body: { parts: [{ type: "text", text: event.message }] },
    });
  }
}

opencodeRouter.post("/new", async (c) => {
  const { agentPath, events } = (await c.req.json()) as {
    agentPath: string;
    events?: IterateEvent[];
  };

  const client = createOpencodeClient({ baseUrl: OPENCODE_BASE_URL });
  const workingDirectory = getAgentWorkingDirectory();
  const response = await client.session.create({
    query: { directory: workingDirectory },
    body: { title: `Agent: ${agentPath}` },
  });

  if (!response.data) {
    return c.json({ error: "Failed to create session" }, 500);
  }

  const sessionId = response.data.id;

  const eventList = Array.isArray(events) ? events : [];
  if (eventList.length > 0) {
    await sendEventsToSession(sessionId, eventList);
  }

  return c.json({
    route: `/opencode/sessions/${sessionId}`,
    sessionId,
    workingDirectory,
  });
});

opencodeRouter.post("/sessions/:sessionId", async (c) => {
  const sessionId = c.req.param("sessionId");
  const payload = await c.req.json();
  const events: IterateEvent[] = Array.isArray(payload) ? payload : [payload];

  await sendEventsToSession(sessionId, events);

  return c.json({ success: true, sessionId });
});
