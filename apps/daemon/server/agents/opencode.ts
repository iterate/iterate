/**
 * OpenCode Agent Harness
 *
 * Uses @opencode-ai/sdk to manage sessions and send messages.
 */

import { createOpencodeClient, type OpencodeClient, type Session } from "@opencode-ai/sdk/v2";
import { getConfig } from "../config-loader.ts";
import type {
  AgentHarness,
  AgentEvent,
  AppendParams,
  CreateAgentParams,
  CreateAgentResult,
  StartCommandOptions,
} from "./types.ts";

const logger = console;

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

    return { harnessSessionId };
  },

  async append(harnessSessionId: string, event: AgentEvent, params: AppendParams): Promise<void> {
    if (event.type !== "user-message") {
      throw new Error(`Unsupported event type: ${event.type}`);
    }

    const client = createClient({ directory: params.workingDirectory });
    const config = getConfig();

    // Track session for acknowledgment lifecycle
    await trackSession(harnessSessionId, params);

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

// #region Session Acknowledgment Tracking
// ============================================================================
// Tracks active sessions and calls unacknowledge when they become idle.
// Used to manage external acknowledgment signals (e.g., emoji reactions).
// ============================================================================

interface SessionTracking {
  sessionId: string;
  unacknowledge: () => Promise<void>;
  workingDirectory: string;
}

// Track active sessions and their callbacks
const trackedSessions = new Map<string, SessionTracking>();

// Event subscription state
let subscriptionActive = false;

/**
 * Stop tracking a session and call its unacknowledge callback.
 */
async function stopTracking(sessionId: string): Promise<void> {
  const tracking = trackedSessions.get(sessionId);
  if (!tracking) return;

  try {
    await tracking.unacknowledge();
  } catch (error) {
    logger.error(`[opencode] Error calling unacknowledge for session ${sessionId}:`, error);
  }
  trackedSessions.delete(sessionId);
  logger.log(`[opencode] Stopped tracking session ${sessionId}`);
}

/**
 * Handle a single event from opencode.
 * The SDK's event stream yields GlobalEvent objects with directory and payload fields.
 */
function handleEvent(event: unknown): void {
  if (!event || typeof event !== "object") return;

  // GlobalEvent has { directory: string, payload: Event }
  const globalEvent = event as {
    directory?: string;
    payload?: { type?: string; properties?: unknown };
  };
  const payload = globalEvent.payload;
  if (!payload || typeof payload !== "object") return;

  const eventType = payload.type;

  // Handle session.idle events - this fires when the agent finishes its turn
  if (eventType === "session.idle") {
    const props = payload.properties as { sessionID?: string } | undefined;
    if (props?.sessionID && trackedSessions.has(props.sessionID)) {
      logger.log(`[opencode] Session ${props.sessionID} became idle`);
      stopTracking(props.sessionID);
    }
  }

  // Also handle session.status with type: idle
  if (eventType === "session.status") {
    const props = payload.properties as
      | { sessionID?: string; status?: { type?: string } }
      | undefined;
    if (
      props?.sessionID &&
      props?.status?.type === "idle" &&
      trackedSessions.has(props.sessionID)
    ) {
      logger.log(`[opencode] Session ${props.sessionID} status changed to idle`);
      stopTracking(props.sessionID);
    }
  }
}

/**
 * Process incoming events from opencode.
 */
async function processEvents(stream: AsyncGenerator<unknown>): Promise<void> {
  for await (const event of stream) {
    try {
      handleEvent(event);
    } catch (error) {
      logger.error(`[opencode] Error handling event:`, error);
    }
  }

  logger.log(`[opencode] Event subscription ended`);
  subscriptionActive = false;
}

/**
 * Ensure we have an active event subscription for session tracking.
 */
async function ensureEventSubscription(workingDirectory: string): Promise<void> {
  if (subscriptionActive) return;

  subscriptionActive = true;
  const client = createClient({ directory: workingDirectory });

  try {
    logger.log(`[opencode] Starting event subscription for session tracking`);
    const subscription = await client.event.subscribe();

    // Process events in background using the stream property
    processEvents(subscription.stream).catch((error) => {
      logger.error(`[opencode] Event processing error:`, error);
      subscriptionActive = false;
    });
  } catch (error) {
    logger.error(`[opencode] Failed to subscribe to events:`, error);
    subscriptionActive = false;
  }
}

/**
 * Track a session for acknowledgment lifecycle.
 * Calls acknowledge immediately and sets up listener to call unacknowledge on idle.
 */
async function trackSession(sessionId: string, params: AppendParams): Promise<void> {
  // Call acknowledge immediately
  try {
    await params.acknowledge();
  } catch (error) {
    logger.error(`[opencode] Error calling acknowledge for session ${sessionId}:`, error);
  }

  // Store tracking info
  trackedSessions.set(sessionId, {
    sessionId,
    unacknowledge: params.unacknowledge,
    workingDirectory: params.workingDirectory,
  });

  logger.log(`[opencode] Tracking session ${sessionId}`);

  // Start event subscription if not already running
  await ensureEventSubscription(params.workingDirectory);
}

// #endregion
