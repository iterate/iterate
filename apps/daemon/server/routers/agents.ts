import { Hono, type Context } from "hono";
import { stream } from "hono/streaming";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { subscribeAgentLifecycle } from "../services/agent-lifecycle.ts";
import { extractAgentPathFromUrl } from "../utils/agent-path.ts";
import { trpcRouter } from "../trpc/router.ts";

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

async function forwardAgentRequest(c: Context): Promise<Response> {
  const agentPath = extractAgentPathFromUrl(c.req.path, "/api/agents");

  if (!agentPath) {
    return c.json({ error: "Invalid agent path" }, 400);
  }

  const method = c.req.method;
  if (method !== "GET" && method !== "POST") {
    return c.json({ error: `Method not allowed: ${method}` }, 405);
  }

  const caller = trpcRouter.createCaller({});
  const { route } = await caller.getOrCreateAgent({
    agentPath,
    createWithEvents: [],
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

  const destination = readyRoute.destination.startsWith("http")
    ? readyRoute.destination
    : `${DAEMON_BASE_URL}/api${readyRoute.destination}`;

  const upstreamHeaders = new Headers();
  const accept = c.req.header("accept");
  if (accept) upstreamHeaders.set("Accept", accept);
  if (method === "POST") {
    upstreamHeaders.set("Content-Type", "application/json");
  }
  upstreamHeaders.set("x-iterate-agent-path", agentPath);

  const upstreamResponse = await fetch(destination, {
    method,
    headers: upstreamHeaders,
    body: method === "POST" ? JSON.stringify(await c.req.json()) : undefined,
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

agentsRouter.get("/*/lifecycle", async (c) => {
  const fullPath = extractAgentPathFromUrl(c.req.path, "/api/agents");
  if (!fullPath || !fullPath.endsWith("/lifecycle")) {
    return c.json({ error: "Invalid lifecycle path" }, 400);
  }
  const agentPath = fullPath.slice(0, -"/lifecycle".length);
  if (!agentPath) {
    return c.json({ error: "Invalid agent path" }, 400);
  }

  c.header("content-type", "text/event-stream");
  c.header("cache-control", "no-cache");
  c.header("connection", "keep-alive");

  return stream(c, async (streamWriter) => {
    let writeQueue = Promise.resolve();
    const enqueueWrite = (chunk: string): void => {
      writeQueue = writeQueue
        .then(() => Promise.resolve(streamWriter.write(chunk)).then(() => undefined))
        .catch(() => {});
    };

    const unsubscribe = subscribeAgentLifecycle(agentPath, (event) => {
      enqueueWrite(`data: ${JSON.stringify(event)}\n\n`);
    });

    try {
      enqueueWrite(": connected\n\n");
      while (!c.req.raw.signal.aborted) {
        await new Promise((resolve) => setTimeout(resolve, 15000));
        enqueueWrite(": ping\n\n");
      }
    } finally {
      unsubscribe();
      await writeQueue;
    }
  });
});

agentsRouter.get("/*", async (c) => forwardAgentRequest(c));

agentsRouter.post("/*", async (c) => forwardAgentRequest(c));
