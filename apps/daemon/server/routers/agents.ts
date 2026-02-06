import { Hono } from "hono";
import { stream } from "hono/streaming";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { extractAgentPathFromUrl } from "../utils/agent-path.ts";
import { trpcRouter } from "../trpc/router.ts";
import type { IterateEvent } from "../types/events.ts";
import { isPromptEvent } from "../types/events.ts";

export const agentsRouter = new Hono();

const DAEMON_PORT = process.env.PORT || "3001";
const DAEMON_BASE_URL = `http://localhost:${DAEMON_PORT}`;

// Headers to forward from upstream response (excluding hop-by-hop headers)
const FORWARDED_HEADERS = ["content-type", "cache-control", "x-request-id", "x-correlation-id"];

const ROUTE_READY_MAX_ATTEMPTS = 40;
const ROUTE_READY_DELAY_MS = 250;

/** Determine which agent router to use for creating new agents based on path prefix */
function getNewAgentPath(agentPath: string): string {
  const prefix = agentPath.split("/")[1]; // e.g., "/pi/test" → "pi"
  switch (prefix) {
    case "pi":
      return "/pi/new";
    case "claude":
      return "/claude/new";
    case "codex":
      return "/codex/new";
    default:
      return "/opencode/new";
  }
}

async function waitForReadyRoute(
  caller: ReturnType<typeof trpcRouter.createCaller>,
  agentPath: string,
  initialRoute: { destination: string } | null,
): Promise<{ destination: string } | null> {
  if (initialRoute && initialRoute.destination !== "pending") {
    return initialRoute;
  }

  for (let attempt = 0; attempt < ROUTE_READY_MAX_ATTEMPTS; attempt += 1) {
    const route = await caller.getActiveRoute({ agentPath });
    if (route && route.destination !== "pending") {
      return route;
    }
    await new Promise((resolve) => setTimeout(resolve, ROUTE_READY_DELAY_MS));
  }

  return initialRoute;
}

agentsRouter.post("/*", async (c) => {
  const agentPath = extractAgentPathFromUrl(c.req.path, "/api/agents");

  if (!agentPath) {
    return c.json({ error: "Invalid agent path" }, 400);
  }

  const payload = await c.req.json();
  const rawEvents = Array.isArray(payload) ? payload : [payload];
  // Filter to only valid IterateEvents (prompt events)
  const events: IterateEvent[] = rawEvents.filter(isPromptEvent);

  const caller = trpcRouter.createCaller({});
  const { route, wasCreated } = await caller.getOrCreateAgent({
    agentPath,
    createWithEvents: events,
    newAgentPath: getNewAgentPath(agentPath),
  });

  const readyRoute = await waitForReadyRoute(caller, agentPath, route);
  if (!readyRoute || readyRoute.destination === "pending") {
    return c.json(
      {
        error: "Agent route is not ready",
        agentPath,
      },
      503,
    );
  }

  if (!wasCreated) {
    const destination = readyRoute.destination.startsWith("http")
      ? readyRoute.destination
      : `${DAEMON_BASE_URL}/api${readyRoute.destination}`;

    const upstreamResponse = await fetch(destination, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    // Forward relevant headers from upstream
    for (const header of FORWARDED_HEADERS) {
      const value = upstreamResponse.headers.get(header);
      if (value) {
        c.header(header, value);
      }
    }

    c.status(upstreamResponse.status as ContentfulStatusCode);

    // Just pipe the response body through - works for both streaming and non-streaming
    if (upstreamResponse.body) {
      return stream(c, async (streamWriter) => {
        const reader = upstreamResponse.body!.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            await streamWriter.write(value);
          }
        } finally {
          reader.releaseLock();
        }
      });
    }

    return c.body(null);
  }

  return c.json({
    success: true,
    agentPath,
    wasCreated,
    route: readyRoute.destination,
  });
});
