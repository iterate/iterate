/**
 * OpenCode Agent Harness
 *
 * Uses @opencode-ai/sdk to manage sessions and send messages.
 */

import {
  createOpencodeClient,
  type OpencodeClient,
  type Session,
  type Event as OpencodeRuntimeEvent,
} from "@opencode-ai/sdk/v2";
import { SpanStatusCode, context, trace, type Context, type Span } from "@opentelemetry/api";
import { getConfig } from "../config-loader.ts";
import { withSpan } from "../utils/otel.ts";
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
const IDLE_WAIT_TIMEOUT_MS = 60000;
const eventTracer = trace.getTracer("iterate.daemon.opencode.events");

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
    { attributes: { "opencode.session_id": sessionId } },
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

  async append(harnessSessionId: string, event: AgentEvent, params: AppendParams): Promise<void> {
    if (event.type !== "user-message") {
      throw new Error(`Unsupported event type: ${event.type}`);
    }

    await withSpan(
      "daemon.opencode.append",
      {
        attributes: {
          "opencode.session_id": harnessSessionId,
          "agent.event_type": event.type,
          "agent.message_length": event.content.length,
        },
      },
      async () => {
        const client = createClient({ directory: params.workingDirectory });
        const config = getConfig();

        // Track session for acknowledgment lifecycle
        await withSpan(
          "daemon.opencode.track_session",
          {
            attributes: {
              "opencode.session_id": harnessSessionId,
            },
          },
          async () => trackSession(harnessSessionId, params),
        );

        // Send message via SDK using session.prompt()
        await withSpan(
          "daemon.opencode.prompt",
          {
            attributes: {
              "opencode.session_id": harnessSessionId,
              ...(config.defaultModel ? { "llm.model": String(config.defaultModel) } : {}),
            },
          },
          async () => {
            setTrackedSessionParentContext(harnessSessionId, context.active());
            await client.session.prompt({
              sessionID: harnessSessionId,
              parts: [{ type: "text", text: event.content }],
              // Use default model from config if available
              ...(config.defaultModel && { model: config.defaultModel }),
            });
          },
        );

        await withSpan(
          "daemon.opencode.wait_for_idle",
          {
            attributes: {
              "opencode.session_id": harnessSessionId,
            },
          },
          async () => waitForSessionIdle(harnessSessionId),
        );
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

// #region Session Acknowledgment Tracking
// ============================================================================
// Tracks active sessions and calls unacknowledge when they become idle.
// Used to manage external acknowledgment signals (e.g., emoji reactions).
// ============================================================================

interface SessionTracking {
  sessionId: string;
  unacknowledge: () => Promise<void>;
  workingDirectory: string;
  startedAtMs: number;
  firstBusyAtMs?: number;
  firstAssistantMessageAtMs?: number;
  firstPartAtMs?: number;
  idlePromise: Promise<void>;
  resolveIdle: () => void;
  activePhase?: {
    kind: string;
    startedAtMs: number;
    span: Span;
  };
  parentContext: Context;
}

// Track active sessions and their callbacks
const trackedSessions = new Map<string, SessionTracking>();

// Event subscription state
let subscriptionActive = false;

function summarizeEvent(event: OpencodeRuntimeEvent): Record<string, unknown> {
  const props = event.properties as Record<string, unknown>;
  return {
    type: event.type,
    sessionId:
      (typeof props?.sessionID === "string" && props.sessionID) ||
      (typeof props?.sessionId === "string" && props.sessionId) ||
      null,
    status:
      props?.status && typeof props.status === "object"
        ? ((props.status as { type?: unknown }).type ?? null)
        : null,
    propertyKeys: props ? Object.keys(props).slice(0, 10) : [],
  };
}

function getTrackedSession(sessionId: string): SessionTracking | undefined {
  return trackedSessions.get(sessionId);
}

function getIdlePromise(sessionId: string): Promise<void> | undefined {
  return getTrackedSession(sessionId)?.idlePromise;
}

function setTrackedSessionParentContext(sessionId: string, parentContext: Context): void {
  const tracking = getTrackedSession(sessionId);
  if (!tracking) return;
  tracking.parentContext = parentContext;
}

async function waitForSessionIdle(
  sessionId: string,
  timeoutMs = IDLE_WAIT_TIMEOUT_MS,
): Promise<void> {
  const idlePromise = getIdlePromise(sessionId);
  if (!idlePromise) return;

  await new Promise<void>((resolve) => {
    let settled = false;
    const timeoutId = setTimeout(() => {
      if (settled) return;
      settled = true;
      logger.warn("[opencode] Timed out waiting for session idle", { sessionId, timeoutMs });
      resolve();
    }, timeoutMs);

    idlePromise
      .then(() => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        resolve();
      })
      .catch(() => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        resolve();
      });
  });
}

function endActivePhase(tracking: SessionTracking, reason: string): void {
  if (!tracking.activePhase) return;
  const elapsedMs = Date.now() - tracking.activePhase.startedAtMs;
  tracking.activePhase.span.setAttribute("phase.elapsed_ms", elapsedMs);
  tracking.activePhase.span.setAttribute("phase.end_reason", reason);
  tracking.activePhase.span.setStatus({ code: SpanStatusCode.OK });
  tracking.activePhase.span.end();
  tracking.activePhase = undefined;
}

function setActivePhase(
  tracking: SessionTracking,
  params: { sessionId: string; phase: string; messageId?: string; partId?: string },
): void {
  if (tracking.activePhase?.kind === params.phase) return;
  endActivePhase(tracking, `switch:${params.phase}`);
  const phaseName = params.phase.replaceAll(":", ".");
  const span = eventTracer.startSpan(
    `daemon.opencode.phase.${phaseName}`,
    {
      attributes: {
        "opencode.session_id": params.sessionId,
        "opencode.phase": params.phase,
        ...(params.messageId ? { "opencode.message_id": params.messageId } : {}),
        ...(params.partId ? { "opencode.part_id": params.partId } : {}),
      },
    },
    tracking.parentContext,
  );
  tracking.activePhase = {
    kind: params.phase,
    startedAtMs: Date.now(),
    span,
  };
}

function getSessionIdFromEvent(event: OpencodeRuntimeEvent): string | undefined {
  switch (event.type) {
    case "session.status":
    case "session.idle":
      return event.properties.sessionID;
    case "message.updated":
      return event.properties.info.sessionID;
    case "message.part.updated":
      return event.properties.part.sessionID;
    case "session.error":
      return event.properties.sessionID;
    default:
      return undefined;
  }
}

/**
 * Stop tracking a session and call its unacknowledge callback.
 */
async function stopTracking(sessionId: string): Promise<void> {
  const tracking = trackedSessions.get(sessionId);
  if (!tracking) return;

  // Delete first to prevent duplicate calls (both session.idle and session.status fire)
  trackedSessions.delete(sessionId);
  const elapsedMs = Date.now() - tracking.startedAtMs;
  logger.log(`[opencode] Stopped tracking session ${sessionId}`, {
    elapsedMs,
    trackedSessionCount: trackedSessions.size,
  });
  endActivePhase(tracking, "session_stopped");
  tracking.resolveIdle();

  try {
    await tracking.unacknowledge();
  } catch (error) {
    logger.error(`[opencode] Error calling unacknowledge for session ${sessionId}:`, error);
  }
}

/**
 * Handle a single event from opencode.
 * Events come directly as { type, properties } objects (not wrapped in GlobalEvent).
 */
function handleEvent(event: OpencodeRuntimeEvent): void {
  const sessionId = getSessionIdFromEvent(event);
  const tracking = sessionId ? getTrackedSession(sessionId) : undefined;

  if (event.type === "session.status" && tracking) {
    const statusType = event.properties.status.type;
    if (sessionId) {
      setActivePhase(tracking, {
        sessionId,
        phase: `status:${statusType}`,
      });
    }
    if (statusType === "busy" && !tracking.firstBusyAtMs) {
      tracking.firstBusyAtMs = Date.now();
      logger.log("[opencode] First busy status", {
        sessionId,
        elapsedMs: tracking.firstBusyAtMs - tracking.startedAtMs,
      });
    }
    if (statusType === "retry") {
      logger.warn("[opencode] Retry status", {
        sessionId,
        attempt: event.properties.status.attempt,
        message: event.properties.status.message,
        nextMs: event.properties.status.next,
      });
    }
    if (statusType === "idle") {
      logger.log(`[opencode] Session ${sessionId} status changed to idle`);
      if (sessionId) {
        void stopTracking(sessionId);
      }
    }
  }

  if (event.type === "message.updated" && tracking && event.properties.info.role === "assistant") {
    if (sessionId) {
      setActivePhase(tracking, {
        sessionId,
        phase: "message:assistant",
        messageId: event.properties.info.id,
      });
    }
    if (!tracking.firstAssistantMessageAtMs) {
      tracking.firstAssistantMessageAtMs = Date.now();
      logger.log("[opencode] First assistant message", {
        sessionId,
        elapsedMs: tracking.firstAssistantMessageAtMs - tracking.startedAtMs,
      });
    }
  }

  if (event.type === "message.part.updated" && tracking) {
    if (sessionId) {
      setActivePhase(tracking, {
        sessionId,
        phase: `part:${event.properties.part.type}`,
        messageId: event.properties.part.messageID,
        partId: event.properties.part.id,
      });
    }
    if (!tracking.firstPartAtMs) {
      tracking.firstPartAtMs = Date.now();
      logger.log("[opencode] First message part", {
        sessionId,
        partType: event.properties.part.type,
        elapsedMs: tracking.firstPartAtMs - tracking.startedAtMs,
      });
    }
  }

  if (event.type === "session.error") {
    logger.error("[opencode] Session error event", {
      sessionId: event.properties.sessionID ?? null,
      error: event.properties.error,
    });
    if (tracking?.activePhase) {
      tracking.activePhase.span.setStatus({ code: SpanStatusCode.ERROR, message: "session.error" });
      endActivePhase(tracking, "session_error");
    }
  }

  if (event.type === "session.idle" && tracking && sessionId) {
    logger.log(`[opencode] Session ${sessionId} became idle`);
    void stopTracking(sessionId);
  }
}

/**
 * Process incoming events from opencode.
 */
async function processEvents(stream: AsyncGenerator<OpencodeRuntimeEvent>): Promise<void> {
  logger.log(`[opencode] Event subscription started`);

  for await (const event of stream) {
    try {
      logger.log("[opencode] Event emitted", summarizeEvent(event));
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
    processEvents(subscription.stream as AsyncGenerator<OpencodeRuntimeEvent>).catch((error) => {
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

  let resolveIdle = () => {};
  const idlePromise = new Promise<void>((resolve) => {
    resolveIdle = resolve;
  });

  // Store tracking info
  trackedSessions.set(sessionId, {
    sessionId,
    unacknowledge: params.unacknowledge,
    workingDirectory: params.workingDirectory,
    startedAtMs: Date.now(),
    idlePromise,
    resolveIdle,
    parentContext: context.active(),
  });

  logger.log(`[opencode] Tracking session ${sessionId}`);

  // Start event subscription if not already running
  await ensureEventSubscription(params.workingDirectory);
}

// #endregion
