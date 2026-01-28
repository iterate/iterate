import { Hono } from "hono";
import { stream } from "hono/streaming";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { extractAgentPathFromUrl } from "../utils/agent-path.ts";
import { trpcRouter } from "../trpc/router.ts";

export const agentsRouter = new Hono();

// Headers to forward from upstream response (excluding hop-by-hop headers)
const FORWARDED_HEADERS = ["content-type", "cache-control", "x-request-id", "x-correlation-id"];

agentsRouter.post("/*", async (c) => {
  const agentPath = extractAgentPathFromUrl(c.req.path, "/api/agents");

  if (!agentPath) {
    return c.json({ error: "Invalid agent path" }, 400);
  }

  const payload = await c.req.json();
  const events = Array.isArray(payload) ? payload : [payload];

  const caller = trpcRouter.createCaller({});
  const { route, wasCreated } = await caller.getOrCreateAgent({
    agentPath,
    createWithEvents: events,
    newAgentPath: "/opencode/new",
  });

  if (!wasCreated && route) {
    const destination = route.destination.startsWith("http")
      ? route.destination
      : `http://localhost:3000/api${route.destination}`;

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
    route: route?.destination ?? null,
  });
});
