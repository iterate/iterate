import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { extractAgentPathFromUrl } from "../utils/agent-path.ts";
import { trpcRouter } from "../trpc/router.ts";

export const agentsRouter = new Hono();

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

    const response = await fetch(destination, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const body = await response.json();
    return c.json(body, response.status as ContentfulStatusCode);
  }

  return c.json({
    success: true,
    agentPath,
    wasCreated,
    route: route?.destination ?? null,
  });
});
