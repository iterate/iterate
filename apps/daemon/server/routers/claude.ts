import { Hono } from "hono";
import { query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { IterateEvent } from "../types/events.ts";
import { isPromptEvent } from "../types/events.ts";
import { getAgentWorkingDirectory } from "../utils/agent-working-directory.ts";

export const claudeRouter = new Hono();

interface ClaudeSession {
  sessionId: string;
  workingDirectory: string;
}

// Track active sessions
const sessions = new Map<string, ClaudeSession>();

/** Concatenate all prompt events into a single message */
function concatenatePrompts(events: IterateEvent[]): string {
  return events
    .filter(isPromptEvent)
    .map((e) => e.message)
    .join("\n\n");
}

function isSystemInitMessage(
  message: SDKMessage,
): message is Extract<SDKMessage, { type: "system"; subtype: "init" }> {
  return message.type === "system" && "subtype" in message && message.subtype === "init";
}

async function createClaudeSession(
  agentPath: string,
  workingDirectory: string,
  initialPrompt?: string,
): Promise<string> {
  let sessionId: string | undefined;

  const response = query({
    prompt: initialPrompt ?? `You are starting a new session. Agent path: ${agentPath}`,
    options: {
      model: "claude-sonnet-4-5",
      cwd: workingDirectory,
      allowedTools: ["Read", "Edit", "Write", "Glob", "Grep", "Bash"],
    },
  });

  for await (const message of response) {
    // The first message is a system init message with the session ID
    if (isSystemInitMessage(message)) {
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

async function sendPromptToSession(sessionId: string, prompt: string): Promise<void> {
  const session = sessions.get(sessionId);
  if (!session) {
    throw new Error(`Session ${sessionId} not found`);
  }

  const response = query({
    prompt,
    options: {
      resume: sessionId,
      model: "claude-sonnet-4-5",
      cwd: session.workingDirectory,
      allowedTools: ["Read", "Edit", "Write", "Glob", "Grep", "Bash"],
    },
  });

  // Consume the response stream
  for await (const _message of response) {
    // Process messages as they arrive
  }
}

claudeRouter.post("/new", async (c) => {
  const { agentPath, events } = (await c.req.json()) as {
    agentPath: string;
    events?: IterateEvent[];
  };

  const workingDirectory = getAgentWorkingDirectory();
  const eventList = Array.isArray(events) ? events : [];

  // Concatenate all events into one prompt
  const combinedPrompt = concatenatePrompts(eventList);

  try {
    const sessionId = await createClaudeSession(
      agentPath,
      workingDirectory,
      combinedPrompt || undefined,
    );

    return c.json({
      route: `/claude/sessions/${sessionId}`,
      sessionId,
      workingDirectory,
      tui: `claude --resume ${sessionId}`,
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

  // Concatenate all events into one prompt
  const combinedPrompt = concatenatePrompts(events);

  if (!combinedPrompt) {
    return c.json({ success: true, sessionId });
  }

  try {
    await sendPromptToSession(sessionId, combinedPrompt);
    return c.json({ success: true, sessionId });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return c.json({ error: message }, 400);
  }
});
