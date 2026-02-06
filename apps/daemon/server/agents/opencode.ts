/**
 * OpenCode Agent Harness
 *
 * Uses @opencode-ai/sdk to manage sessions and send messages.
 */

import { createOpencodeClient, type OpencodeClient, type Session } from "@opencode-ai/sdk/v2";
import { getConfig } from "../config-loader.ts";
import { withSpan } from "../utils/otel.ts";
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
  await withSpan(
    "daemon.opencode.wait_for_session_ready",
    {
      attributes: {
        "opencode.session_id": sessionId,
      },
    },
    async (span) => {
      const startTime = Date.now();
      let pollCount = 0;

      while (Date.now() - startTime < timeoutMs) {
        pollCount += 1;
        const response = await client.session.list();
        if (response.data) {
          const session = response.data.find((s: Session) => s.id === sessionId);
          if (session) {
            span.setAttribute("opencode.readiness.poll_count", pollCount);
            span.setAttribute("opencode.readiness.wait_ms", Date.now() - startTime);
            return;
          }
        }
        await new Promise((resolve) => setTimeout(resolve, READINESS_POLL_INTERVAL_MS));
      }

      span.setAttribute("opencode.readiness.poll_count", pollCount);
      span.setAttribute("opencode.readiness.wait_ms", Date.now() - startTime);
      throw new Error(`OpenCode session ${sessionId} not ready after ${timeoutMs}ms`);
    },
  );
}

export const opencodeHarness: AgentHarness = {
  type: "opencode",

  async createAgent(params: CreateAgentParams): Promise<CreateAgentResult> {
    // Use provided working directory or fall back to ITERATE_REPO
    // This needs to match the working directory that opencode serve ran with
    const workingDirectory = params.workingDirectory || ITERATE_REPO;

    return withSpan(
      "daemon.opencode.create_agent",
      {
        attributes: {
          "agent.slug": params.slug,
          "agent.working_directory": workingDirectory,
        },
      },
      async (span) => {
        console.log(`Creating OpenCode client for ${workingDirectory}`, { params, ITERATE_REPO });
        const client = createClient({ directory: workingDirectory });

        // Create OpenCode session via SDK
        const response = await client.session.create({ title: `Agent: ${params.slug}` });

        if (!response.data) {
          throw new Error("Failed to create OpenCode session");
        }

        console.log(`Created OpenCode session`, response);

        const harnessSessionId = response.data.id;
        span.setAttribute("opencode.session_id", harnessSessionId);

        // Wait for session to be ready
        await waitForSessionReady(client, harnessSessionId);

        return { harnessSessionId };
      },
    );
  },

  async append(harnessSessionId: string, event: AgentEvent, params): Promise<void> {
    if (event.type !== "user-message") {
      throw new Error(`Unsupported event type: ${event.type}`);
    }

    await withSpan(
      "daemon.opencode.append",
      {
        attributes: {
          "opencode.session_id": harnessSessionId,
          "agent.event_type": event.type,
        },
      },
      async () => {
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
    );
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
