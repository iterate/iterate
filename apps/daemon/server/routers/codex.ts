import { execSync, spawn } from "node:child_process";
import { Hono } from "hono";
import type { IterateEvent } from "../types/events.ts";
import { isPromptEvent } from "../types/events.ts";
import { getAgentWorkingDirectory } from "../utils/agent-working-directory.ts";

export const codexRouter = new Hono();

interface CodexSession {
  sessionId: string;
  workingDirectory: string;
}

// Track active sessions
const sessions = new Map<string, CodexSession>();

// JSONL event types from codex exec --json
interface CodexJsonEvent {
  type: string;
  session_id?: string;
  thread_id?: string;
  // Other fields vary by event type
}

/** Concatenate all prompt events into a single message */
function concatenatePrompts(events: IterateEvent[]): string {
  return events
    .filter(isPromptEvent)
    .map((e) => e.message)
    .join("\n\n");
}

/**
 * Check if codex CLI is installed globally.
 * Throws helpful error if not found.
 */
function assertCodexCliInstalled(): void {
  try {
    execSync("which codex", { stdio: "ignore" });
  } catch {
    throw new Error(
      "Codex CLI not installed. Run: npm install -g @openai/codex\n\n" +
        "Note: We shell out to the CLI instead of using @openai/codex-sdk because " +
        "the SDK is 139MB and causes pnpm to OOM on Node.js 24 due to a V8 bug " +
        "(pnpm/pnpm#9743). The SDK just wraps the CLI anyway.",
    );
  }
}

/**
 * Run codex CLI and return session ID from JSONL output.
 *
 * We shell out to the CLI instead of using @openai/codex-sdk because the SDK
 * package is 139MB and triggers a Node.js 24 V8 regression that causes pnpm
 * to OOM during install (see: https://github.com/pnpm/pnpm/issues/9743).
 * The SDK internally just spawns the CLI and parses JSONL anyway.
 */
async function runCodexCli(
  args: string[],
  workingDirectory: string,
): Promise<{ sessionId: string; output: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn("codex", args, {
      cwd: workingDirectory,
      env: { ...process.env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let sessionId = "";

    proc.stdout.on("data", (data: Buffer) => {
      const chunk = data.toString();
      stdout += chunk;

      // Parse JSONL lines to find session_id
      for (const line of chunk.split("\n")) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line) as CodexJsonEvent;
          // Session ID can come from various event types
          if (event.session_id) {
            sessionId = event.session_id;
          } else if (event.thread_id) {
            sessionId = event.thread_id;
          }
        } catch {
          // Not JSON, ignore
        }
      }
    });

    proc.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    proc.on("close", (code) => {
      if (code !== 0 && !sessionId) {
        reject(new Error(`codex exited with code ${code}: ${stderr}`));
      } else {
        resolve({ sessionId, output: stdout });
      }
    });

    proc.on("error", (err) => {
      reject(new Error(`Failed to spawn codex: ${err.message}`));
    });
  });
}

async function createCodexSession(
  _agentPath: string,
  workingDirectory: string,
  initialPrompt?: string,
): Promise<string> {
  assertCodexCliInstalled();

  // Codex requires a prompt to generate a session - use a minimal one if none provided
  const prompt = initialPrompt || "hello";

  const args = ["exec", "--json", "--skip-git-repo-check", "-C", workingDirectory, prompt];

  const { sessionId } = await runCodexCli(args, workingDirectory);

  if (!sessionId) {
    throw new Error("Failed to get session ID from codex output");
  }

  sessions.set(sessionId, { sessionId, workingDirectory });
  return sessionId;
}

async function sendPromptToSession(sessionId: string, prompt: string): Promise<void> {
  const session = sessions.get(sessionId);
  if (!session) {
    throw new Error(`Session ${sessionId} not found`);
  }

  const args = ["exec", "resume", sessionId, "--json", prompt];
  await runCodexCli(args, session.workingDirectory);
}

codexRouter.post("/new", async (c) => {
  const { agentPath, events } = (await c.req.json()) as {
    agentPath: string;
    events?: IterateEvent[];
  };

  const workingDirectory = getAgentWorkingDirectory();
  const eventList = Array.isArray(events) ? events : [];

  // Concatenate all events into one prompt
  const combinedPrompt = concatenatePrompts(eventList);

  try {
    const sessionId = await createCodexSession(
      agentPath,
      workingDirectory,
      combinedPrompt || undefined,
    );

    return c.json({
      route: `/codex/sessions/${sessionId}`,
      sessionId,
      workingDirectory,
      tui: `codex resume ${sessionId} --all`,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return c.json({ error: message }, 500);
  }
});

codexRouter.post("/sessions/:sessionId", async (c) => {
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
