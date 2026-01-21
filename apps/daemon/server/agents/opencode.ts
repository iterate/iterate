/**
 * OpenCode Agent Harness
 *
 * Uses @opencode-ai/sdk to manage sessions and send messages.
 * No tmux sessions - uses SDK API directly for all operations.
 */

import { createOpencodeClient, type OpencodeClient, type Session } from "@opencode-ai/sdk";
import type {
  AgentHarness,
  AgentEvent,
  CreateAgentParams,
  CreateAgentResult,
  StartCommandOptions,
} from "./types.ts";

// OpenCode server runs on port 4096 (started by PM2)
const OPENCODE_BASE_URL = "http://localhost:4096";

// Root of the iterate repo - used as working directory for all agents
// TODO: In future, use agent-specific working directories from params
const ITERATE_REPO = "/home/iterate/src/github.com/iterate/iterate";

// Polling config for session readiness
const READINESS_POLL_INTERVAL_MS = 200;
const READINESS_TIMEOUT_MS = 10000;

function createClient(): OpencodeClient {
  return createOpencodeClient({
    baseUrl: OPENCODE_BASE_URL,
  });
}

async function waitForSessionReady(
  client: OpencodeClient,
  sessionId: string,
  timeoutMs = READINESS_TIMEOUT_MS,
): Promise<void> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    const response = await client.session.list();
    if (response.data) {
      const session = response.data.find((s: Session) => s.id === sessionId);
      if (session) {
        // Session exists and is ready
        return;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, READINESS_POLL_INTERVAL_MS));
  }

  throw new Error(`OpenCode session ${sessionId} not ready after ${timeoutMs}ms`);
}

export const opencodeHarness: AgentHarness = {
  type: "opencode",

  async createAgent(params: CreateAgentParams): Promise<CreateAgentResult> {
    const client = createClient();

    // Use provided working directory or fall back to ITERATE_REPO
    const workingDirectory = params.workingDirectory || ITERATE_REPO;

    // Create OpenCode session via SDK
    const response = await client.session.create({
      query: { directory: workingDirectory },
      body: { title: `Agent: ${params.slug}` },
    });

    if (!response.data) {
      throw new Error("Failed to create OpenCode session");
    }

    const harnessSessionId = response.data.id;

    // Wait for session to be ready
    await waitForSessionReady(client, harnessSessionId);

    // No tmux session - use opencode SDK streaming API for terminal UI
    return {
      harnessSessionId,
    };
  },

  async append(harnessSessionId: string, event: AgentEvent): Promise<void> {
    if (event.type !== "user-message") {
      throw new Error(`Unsupported event type: ${event.type}`);
    }

    const client = createClient();

    // Send message via SDK using session.prompt()
    await client.session.prompt({
      path: { id: harnessSessionId },
      body: {
        parts: [{ type: "text", text: event.content }],
      },
    });
  },

  getStartCommand(_workingDirectory: string, options?: StartCommandOptions): string[] {
    const cmd = ["opencode"];
    if (options?.prompt) {
      cmd.push("--prompt", options.prompt);
    }
    return cmd;
  },
};
