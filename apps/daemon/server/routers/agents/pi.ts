import { Hono } from "hono";
import type { IterateEvent } from "../../types/events.ts";
import { isPromptEvent } from "../../types/events.ts";
import { getAgentWorkingDirectory } from "../../utils/agent-working-directory.ts";

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
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const activeSessions = new Map<string, any>();

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

  // Process initial events if provided
  const eventList = Array.isArray(events) ? events : [];
  for (const event of eventList) {
    if (!isPromptEvent(event)) continue;
    await session.prompt(event.message);
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

      for (const event of events) {
        if (!isPromptEvent(event)) continue;
        await session.prompt(event.message);
      }

      return c.json({ success: true, sessionId });
    } catch {
      return c.json({ error: `Session ${sessionId} not found` }, 404);
    }
  }

  const { session } = stored;

  for (const event of events) {
    if (!isPromptEvent(event)) continue;
    await session.prompt(event.message);
  }

  return c.json({ success: true, sessionId });
});
