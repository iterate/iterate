import { homedir } from "node:os";
import { inspect } from "node:util";
import { readFileSync } from "node:fs";
import { Hono } from "hono";
import { createOpencodeClient, type Event as OpencodeEvent } from "@opencode-ai/sdk/v2";
import { PromptAddedEvent } from "../types/events.ts";
import { getAgentWorkingDirectory } from "../utils/agent-working-directory.ts";
import { trpcRouter } from "../trpc/router.ts";
import { withSpan } from "../utils/otel.ts";

// Opencode sessions are project-bound - use homedir as neutral location for global sessions
function getOpencodeWorkingDirectory(): string {
  const dir = getAgentWorkingDirectory();
  // If it's the default fallback (cwd), use homedir instead for global accessibility
  if (dir === process.cwd()) {
    return homedir();
  }
  return dir;
}

// ---------------------------------------------------------------------------
// OpenCode adapter
// ---------------------------------------------------------------------------
//
// This router bridges iterate's agent system with OpenCode sessions.
//
// Inbound (callers → agents router → opencode):
//   1. The agents router (agents.ts) calls POST /new to create an OpenCode
//      session for an agent path. The returned `route` is stored in the agent
//      routing table.
//   2. Callers (webchat.ts, slack.ts, other agents, etc.) POST iterate events
//      (see types/events.ts) to the agent's path. The agents router looks up
//      the route and forwards to POST /sessions/:opencodeSessionId here, where
//      the event is translated and sent to the OpenCode SDK.
//
// Outbound (opencode → agents):
//   A single global SSE subscription listens to all OpenCode session events.
//   When a tracked session goes idle/error or updates tool status, we call
//   trpc.updateAgent so the agents table reflects the current state.

const OPENCODE_BASE_URL = process.env.OPENCODE_BASE_URL ?? "http://localhost:4096";
const trpc = trpcRouter.createCaller({});
const opencodeClient = createOpencodeClient({ baseUrl: OPENCODE_BASE_URL });

export const opencodeRouter = new Hono();

/** Maps opencodeSessionId → agentPath so the lifecycle subscription can dispatch events. */
const agentPathByOpencodeSessionId = new Map<string, string>();

opencodeRouter.post("/new", async (c) => {
  const { agentPath } = (await c.req.json()) as { agentPath: string };

  const workingDirectory = getOpencodeWorkingDirectory();
  const response = await opencodeClient.session.create({
    directory: workingDirectory,
    title: `Agent: ${agentPath}`,
  });

  if (!response.data) {
    return c.json({ error: "Failed to create session" }, 500);
  }

  const opencodeSessionId = response.data.id;
  // Canonical harness metadata contract used by debug links/commands.
  const metadata = {
    agentHarness: "opencode",
    opencodeSessionId,
  } as const;

  return c.json({
    route: `/opencode/sessions/${opencodeSessionId}`,
    sessionId: opencodeSessionId,
    metadata,
    workingDirectory,
    tui: `opencode attach ${OPENCODE_BASE_URL} -s ${opencodeSessionId}`,
  });
});

opencodeRouter.post("/sessions/:opencodeSessionId", async (c) => {
  const opencodeSessionId = c.req.param("opencodeSessionId");
  const agentPath = c.req.header("x-iterate-agent-path") ?? undefined;
  const payload = await c.req.json();

  const parsed = PromptAddedEvent.safeParse(payload);
  if (!parsed.success) {
    return c.json({ error: "Expected an iterate:agent:prompt-added event" }, 400);
  }

  const health = await opencodeClient.global.health();

  if (!health.data?.healthy) {
    return c.json({ error: "OpenCode is not healthy: " + inspect(health?.error) }, 503);
  }

  let envFileContent: string;
  try {
    envFileContent = readFileSync(homedir() + "/.iterate/.env", "utf8");
  } catch {
    return c.json({ error: "~/.iterate/.env not found (bootstrap may not have run yet)" }, 503);
  }
  if (!envFileContent.includes("ANTHROPIC_API_KEY")) {
    console.log("ANTHROPIC_API_KEY is not set yet!");
    return c.json({ error: "ANTHROPIC_API_KEY is not set" }, 503);
  }

  const { message } = parsed.data;

  // Fire-and-forget: background the prompt so the caller returns immediately
  void withSpan(
    "daemon.opencode.append-async",
    {
      attributes: {
        "opencode.session_id": opencodeSessionId,
        ...(agentPath ? { "agent.path": agentPath } : {}),
        "prompt.length": message.length,
      },
    },
    async () => {
      if (agentPath) agentPathByOpencodeSessionId.set(opencodeSessionId, agentPath);
      await opencodeClient.session.promptAsync({
        sessionID: opencodeSessionId,
        directory: getOpencodeWorkingDirectory(),
        parts: [{ type: "text", text: message }],
      });
    },
  ).catch((error) => {
    console.error("[opencode] background prompt failed", {
      opencodeSessionId,
      agentPath,
      error: error instanceof Error ? error.message : String(error),
    });
  });

  return c.json({ success: true, sessionId: opencodeSessionId });
});

// ---------------------------------------------------------------------------
// Lifecycle subscription via OpenCode SDK global event stream
// ---------------------------------------------------------------------------
//
// Single global subscription dispatches typed events to tracked agent paths.
// Two signals matter:
//   1. idle / error  -> mark agent not working, clear status
//   2. tool running/completed -> update shortStatus

void (async () => {
  try {
    const result = await opencodeClient.global.event();
    console.log("[opencode] lifecycle subscription connected");

    for await (const globalEvent of result.stream) {
      const event = globalEvent.payload;
      const opencodeSessionId = extractOpencodeSessionId(event);
      if (!opencodeSessionId) continue;

      const agentPath = agentPathByOpencodeSessionId.get(opencodeSessionId);
      if (!agentPath) {
        console.warn("[opencode] no agent path for session", { opencodeSessionId });
        continue;
      }

      const status = agentStatusFromOpencodeEvent(event);

      if (!status) continue;

      if (!status.isWorking) {
        agentPathByOpencodeSessionId.delete(opencodeSessionId);
      }
      await trpc.updateAgent({ path: agentPath, ...status });
    }

    console.warn("[opencode] lifecycle subscription stream ended unexpectedly");
  } catch (error) {
    console.error("[opencode] lifecycle subscription failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
})();

/**
 * Derive agent status from an OpenCode event. Returns null if the event is
 * irrelevant to agent lifecycle (e.g. message.updated, file.edited, etc.).
 */
export function agentStatusFromOpencodeEvent(
  event: OpencodeEvent,
): { isWorking: boolean; shortStatus: string } | null {
  // Idle / error -> not working
  if (
    event.type === "session.idle" ||
    event.type === "session.error" ||
    (event.type === "session.status" && event.properties.status.type === "idle")
  ) {
    return { isWorking: false, shortStatus: "" };
  }

  // Busy session -> thinking (LLM is reasoning, no tool call or text yet)
  if (event.type === "session.status" && event.properties.status.type === "busy") {
    return { isWorking: true, shortStatus: "🤔 Thinking" };
  }

  if (event.type === "message.part.updated") {
    // Text part -> the LLM is generating a response
    if (event.properties.part.type === "text") {
      return { isWorking: true, shortStatus: "✏️ Writing response" };
    }

    // Tool status -> working with a short description
    if (event.properties.part.type === "tool") {
      const { state } = event.properties.part;
      if (state.status !== "running" && state.status !== "completed") return null;

      const title = "title" in state && typeof state.title === "string" ? state.title : "";
      const description =
        state.input && typeof state.input.description === "string" ? state.input.description : "";
      const shortStatus = `🔧 ${(title || description || event.properties.part.tool || "Working").slice(0, 27)}`;
      return { isWorking: true, shortStatus };
    }
  }

  return null;
}

function extractOpencodeSessionId(event: OpencodeEvent): string | null {
  switch (event.type) {
    case "session.status":
    case "session.idle":
      return event.properties.sessionID;
    case "session.error":
      return event.properties.sessionID ?? null;
    case "message.updated":
      return event.properties.info.sessionID;
    case "message.part.updated":
      return event.properties.part.sessionID;
    default:
      return null;
  }
}
