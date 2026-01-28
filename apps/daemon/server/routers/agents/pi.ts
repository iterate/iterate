import { Hono } from "hono";
import type { IterateEvent } from "../../types/events.ts";
import { isPromptEvent } from "../../types/events.ts";
import { getAgentWorkingDirectory } from "../../utils/agent-working-directory.ts";

const PI_API_BASE_URL = process.env.PI_API_BASE_URL ?? "https://api.inflection.ai";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? "";

export const piRouter = new Hono();

interface PiSession {
  sessionId: string;
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
}

// In-memory session store (replace with persistent storage in production)
const sessions = new Map<string, PiSession>();

function generateSessionId(): string {
  return `pi-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

async function sendMessageToPi(
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
): Promise<string> {
  const response = await fetch(`${PI_API_BASE_URL}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: "inflection_3_pi",
      messages,
      max_tokens: 2048,
      temperature: 0.7,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Pi API error: ${response.status} - ${error}`);
  }

  const data = (await response.json()) as {
    choices: Array<{ message: { content: string } }>;
  };
  return data.choices[0]?.message?.content ?? "";
}

async function sendEventsToSession(sessionId: string, events: IterateEvent[]): Promise<void> {
  const session = sessions.get(sessionId);
  if (!session) {
    throw new Error(`Session ${sessionId} not found`);
  }

  for (const event of events) {
    if (!isPromptEvent(event)) continue;

    session.messages.push({ role: "user", content: event.message });
    const assistantResponse = await sendMessageToPi(session.messages);
    session.messages.push({ role: "assistant", content: assistantResponse });
  }
}

piRouter.post("/new", async (c) => {
  const { agentPath, events } = (await c.req.json()) as {
    agentPath: string;
    events?: IterateEvent[];
  };

  const workingDirectory = getAgentWorkingDirectory();
  const sessionId = generateSessionId();

  const session: PiSession = {
    sessionId,
    messages: [
      {
        role: "system",
        content: `You are Pi, a helpful AI assistant. You are working on the project at: ${workingDirectory}. Agent path: ${agentPath}`,
      },
    ],
  };

  sessions.set(sessionId, session);

  const eventList = Array.isArray(events) ? events : [];
  if (eventList.length > 0) {
    await sendEventsToSession(sessionId, eventList);
  }

  return c.json({
    route: `/pi/sessions/${sessionId}`,
    sessionId,
    workingDirectory,
  });
});

piRouter.post("/sessions/:sessionId", async (c) => {
  const sessionId = c.req.param("sessionId");
  const payload = await c.req.json();
  const events: IterateEvent[] = Array.isArray(payload) ? payload : [payload];

  try {
    await sendEventsToSession(sessionId, events);
    return c.json({ success: true, sessionId });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return c.json({ error: message }, 400);
  }
});
