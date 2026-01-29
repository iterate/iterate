import { Hono } from "hono";
import type { IterateEvent } from "../types/events.ts";
import { isPromptEvent } from "../types/events.ts";
import { getAgentWorkingDirectory } from "../utils/agent-working-directory.ts";

export const piRouter = new Hono();

// Dynamic import for optional pi-coding-agent dependency
async function getPiCodingAgent() {
  try {
    return await import("@mariozechner/pi-coding-agent");
  } catch {
    throw new Error("@mariozechner/pi-coding-agent is not installed");
  }
}

// Store active sessions by ID for the API

const activeSessions = new Map<string, any>();

/** Concatenate all prompt events into a single message */
function concatenatePrompts(events: IterateEvent[]): string {
  return events
    .filter(isPromptEvent)
    .map((e) => e.message)
    .join("\n\n");
}

piRouter.post("/new", async (c) => {
  const { agentPath: _agentPath, events } = (await c.req.json()) as {
    agentPath: string;
    events?: IterateEvent[];
  };

  const piAgent = await getPiCodingAgent();
  const workingDirectory = getAgentWorkingDirectory();

  // Create session using the coding agent SDK - this stores sessions in
  // ~/.pi/agent/sessions/<encoded-cwd>/ compatible with `pi --resume`
  const { session } = await piAgent.createAgentSession({
    cwd: workingDirectory,
    // systemPrompt can be customized if needed
  });

  // Get session ID from the session object
  const sessionId = session.sessionId;

  // Store session for API access
  activeSessions.set(sessionId, { session, workingDirectory });

  // Concatenate all events into one prompt and send
  const eventList = Array.isArray(events) ? events : [];
  const combinedPrompt = concatenatePrompts(eventList);
  if (combinedPrompt) {
    await session.prompt(combinedPrompt);
  }

  return c.json({
    route: `/pi/sessions/${sessionId}`,
    sessionId,
    workingDirectory,
    tui: `cd "${workingDirectory}" && pi --resume`,
  });
});

piRouter.post("/sessions/:sessionId", async (c) => {
  const sessionId = c.req.param("sessionId");
  const payload = await c.req.json();
  const events: IterateEvent[] = Array.isArray(payload) ? payload : [payload];

  // Concatenate all events into one prompt
  const combinedPrompt = concatenatePrompts(events);

  const stored = activeSessions.get(sessionId);
  if (!stored) {
    // Try to restore session from disk
    const piAgent = await getPiCodingAgent();
    const workingDirectory = getAgentWorkingDirectory();

    try {
      // Try to continue recent session and check if ID matches
      const sessionManager = piAgent.SessionManager.continueRecent(workingDirectory);
      if (sessionManager.getSessionId() !== sessionId) {
        return c.json({ error: `Session ${sessionId} not found` }, 404);
      }

      const { session } = await piAgent.createAgentSession({
        cwd: workingDirectory,
        sessionManager,
      });

      activeSessions.set(sessionId, { session, workingDirectory });

      if (combinedPrompt) {
        await session.prompt(combinedPrompt);
      }

      return c.json({ success: true, sessionId });
    } catch {
      return c.json({ error: `Session ${sessionId} not found` }, 404);
    }
  }

  const { session } = stored;

  if (combinedPrompt) {
    await session.prompt(combinedPrompt);
  }

  return c.json({ success: true, sessionId });
});
