import { Hono } from "hono";
import type { IterateEvent } from "../../types/events.ts";
import { isPromptEvent } from "../../types/events.ts";
import { getAgentWorkingDirectory } from "../../utils/agent-working-directory.ts";

export const claudeRouter = new Hono();

interface ClaudeSession {
  sessionId: string;
  workingDirectory: string;
}

// Track active sessions
const sessions = new Map<string, ClaudeSession>();

// Dynamic import wrapper for optional Claude Agent SDK
async function getClaudeSDK(): Promise<{
  query: (opts: {
    prompt: string;
    options: {
      model?: string;
      resume?: string;
      workingDirectory?: string;
      allowedTools?: string[];
    };
  }) => AsyncIterable<{
    type: string;
    subtype?: string;
    session_id?: string;
  }>;
} | null> {
  try {
    const sdk = await import("@anthropic-ai/claude-agent-sdk");
    return sdk;
  } catch {
    return null;
  }
}

async function createClaudeSession(
  agentPath: string,
  workingDirectory: string,
  initialPrompt?: string,
): Promise<string> {
  const sdk = await getClaudeSDK();
  if (!sdk) {
    throw new Error("Claude Agent SDK not installed. Run: pnpm add @anthropic-ai/claude-agent-sdk");
  }

  let sessionId: string | undefined;

  const response = sdk.query({
    prompt: initialPrompt ?? `You are starting a new session. Agent path: ${agentPath}`,
    options: {
      model: "claude-sonnet-4-5",
      workingDirectory,
      allowedTools: ["Read", "Edit", "Write", "Glob", "Grep", "Bash"],
    },
  });

  for await (const message of response) {
    // The first message is a system init message with the session ID
    if (message.type === "system" && message.subtype === "init" && message.session_id) {
      sessionId = message.session_id;
      break;
    }
  }

  if (!sessionId) {
    throw new Error("Failed to get session ID from Claude Agent SDK");
  }

  sessions.set(sessionId, { sessionId, workingDirectory });
  return sessionId;
}

async function sendEventsToSession(sessionId: string, events: IterateEvent[]): Promise<void> {
  const session = sessions.get(sessionId);
  if (!session) {
    throw new Error(`Session ${sessionId} not found`);
  }

  const sdk = await getClaudeSDK();
  if (!sdk) {
    throw new Error("Claude Agent SDK not installed");
  }

  for (const event of events) {
    if (!isPromptEvent(event)) continue;

    const response = sdk.query({
      prompt: event.message,
      options: {
        resume: sessionId,
        model: "claude-sonnet-4-5",
        workingDirectory: session.workingDirectory,
        allowedTools: ["Read", "Edit", "Write", "Glob", "Grep", "Bash"],
      },
    });

    // Consume the response stream
    for await (const _message of response) {
      // Process messages as they arrive
    }
  }
}

claudeRouter.post("/new", async (c) => {
  const { agentPath, events } = (await c.req.json()) as {
    agentPath: string;
    events?: IterateEvent[];
  };

  const workingDirectory = getAgentWorkingDirectory();

  // Get initial prompt from events if available
  const eventList = Array.isArray(events) ? events : [];
  const initialPromptEvent = eventList.find(isPromptEvent);
  const initialPrompt = initialPromptEvent?.message;

  try {
    const sessionId = await createClaudeSession(agentPath, workingDirectory, initialPrompt);

    // Send remaining events (skip the first if it was used as initial prompt)
    const remainingEvents = initialPrompt ? eventList.slice(1) : eventList;
    if (remainingEvents.length > 0) {
      await sendEventsToSession(sessionId, remainingEvents);
    }

    return c.json({
      route: `/claude/sessions/${sessionId}`,
      sessionId,
      workingDirectory,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return c.json({ error: message }, 500);
  }
});

claudeRouter.post("/sessions/:sessionId", async (c) => {
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
