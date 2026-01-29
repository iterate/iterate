/**
 * OpenCode Agent Harness
 *
 * Uses @opencode-ai/sdk to manage sessions and send messages.
 * No tmux sessions - uses SDK API directly for all operations.
 */

import { createOpencodeClient, type OpencodeClient, type Session } from "@opencode-ai/sdk/v2";
import { getConfig } from "../config-loader.ts";
import type {
  AgentHarness,
  AgentEvent,
  CreateAgentParams,
  CreateAgentResult,
  StartCommandOptions,
} from "./types.ts";

// OpenCode server runs on port 4096 (started by s6)
const OPENCODE_BASE_URL = "http://localhost:4096";

// Root of the iterate repo - used as working directory for all agents
// TODO: In future, use agent-specific working directories from params
const ITERATE_REPO = "/home/iterate/src/github.com/iterate/iterate";

// Polling config for session readiness
const READINESS_POLL_INTERVAL_MS = 200;
const READINESS_TIMEOUT_MS = 10000;

function createClient(params: { directory: string }): OpencodeClient {
  return createOpencodeClient({
    baseUrl: OPENCODE_BASE_URL,
    directory: params.directory,
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
    // Use provided working directory or fall back to ITERATE_REPO
    // This needs to match the working directory that opencode serve ran with
    const workingDirectory = params.workingDirectory || ITERATE_REPO;

    console.log(`Creating OpenCode client for ${workingDirectory}`, { params, ITERATE_REPO });
    const client = createClient({ directory: workingDirectory });

    // Create OpenCode session via SDK
    const response = await client.session.create({ title: `Agent: ${params.slug}` });

    if (!response.data) {
      throw new Error("Failed to create OpenCode session");
    }

    console.log(`Created OpenCode session`, response);

    const harnessSessionId = response.data.id;

    // Wait for session to be ready
    await waitForSessionReady(client, harnessSessionId);

    // No tmux session - use opencode SDK streaming API for terminal UI
    return {
      harnessSessionId,
    };
  },

  async append(harnessSessionId: string, event: AgentEvent, params): Promise<void> {
    if (event.type !== "user-message") {
      throw new Error(`Unsupported event type: ${event.type}`);
    }

    const client = createClient({ directory: params.workingDirectory });
    const config = getConfig();

    // Send message via SDK using session.prompt()
    await client.session.prompt({
      sessionID: harnessSessionId,
      parts: [{ type: "text", text: event.content }],
      // Use default model from config if available
      ...(config.defaultModel && { model: config.defaultModel }),
    });
  },

  getStartCommand(_workingDirectory: string, options?: StartCommandOptions): string[] {
    const cmd = ["opencode"]; // this is now broken - needs to be opencode-customer or /home/iterate/.opencode/bin/opencode for vanilla opencode
    // but i don't think we use this anymore!
    if (options?.prompt) {
      cmd.push("--prompt", options.prompt);
    }
    return cmd;
  },
};
