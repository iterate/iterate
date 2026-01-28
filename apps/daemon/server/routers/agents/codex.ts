import { Hono } from "hono";
import type { IterateEvent } from "../../types/events.ts";
import { isPromptEvent } from "../../types/events.ts";
import { getAgentWorkingDirectory } from "../../utils/agent-working-directory.ts";

export const codexRouter = new Hono();

interface CodexSession {
  threadId: string;
  workingDirectory: string;
}

// Track active sessions
const sessions = new Map<string, CodexSession>();

// Type definitions for Codex SDK
interface CodexThread {
  id: string;
  run(prompt: string): Promise<unknown>;
}

interface CodexClient {
  startThread(): CodexThread;
  resumeThread(threadId: string): CodexThread;
}

interface CodexConstructor {
  new (opts: { workingDirectory: string }): CodexClient;
}

// Dynamic import wrapper for optional Codex SDK
async function getCodexSDK(): Promise<{ Codex: CodexConstructor } | null> {
  try {
    const sdk = await import("@openai/codex-sdk");
    return sdk as unknown as { Codex: CodexConstructor };
  } catch {
    return null;
  }
}

async function createCodexSession(
  _agentPath: string,
  workingDirectory: string,
  initialPrompt?: string,
): Promise<string> {
  const sdk = await getCodexSDK();
  if (!sdk) {
    throw new Error("Codex SDK not installed. Run: pnpm add @openai/codex-sdk");
  }

  const codex = new sdk.Codex({
    workingDirectory,
  });

  const thread = codex.startThread();

  if (initialPrompt) {
    await thread.run(initialPrompt);
  }

  const threadId = thread.id;
  sessions.set(threadId, { threadId, workingDirectory });

  return threadId;
}

async function sendEventsToSession(threadId: string, events: IterateEvent[]): Promise<void> {
  const session = sessions.get(threadId);
  if (!session) {
    throw new Error(`Session ${threadId} not found`);
  }

  const sdk = await getCodexSDK();
  if (!sdk) {
    throw new Error("Codex SDK not installed");
  }

  const codex = new sdk.Codex({
    workingDirectory: session.workingDirectory,
  });

  const thread = codex.resumeThread(threadId);

  for (const event of events) {
    if (!isPromptEvent(event)) continue;
    await thread.run(event.message);
  }
}

codexRouter.post("/new", async (c) => {
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
    const threadId = await createCodexSession(agentPath, workingDirectory, initialPrompt);

    // Send remaining events (skip the first if it was used as initial prompt)
    const remainingEvents = initialPrompt ? eventList.slice(1) : eventList;
    if (remainingEvents.length > 0) {
      await sendEventsToSession(threadId, remainingEvents);
    }

    return c.json({
      route: `/codex/sessions/${threadId}`,
      sessionId: threadId,
      workingDirectory,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return c.json({ error: message }, 500);
  }
});

codexRouter.post("/sessions/:threadId", async (c) => {
  const threadId = c.req.param("threadId");
  const payload = await c.req.json();
  const events: IterateEvent[] = Array.isArray(payload) ? payload : [payload];

  try {
    await sendEventsToSession(threadId, events);
    return c.json({ success: true, sessionId: threadId });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return c.json({ error: message }, 400);
  }
});
