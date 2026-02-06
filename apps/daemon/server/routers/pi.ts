import { Hono } from "hono";
import type { IterateEvent } from "../types/events.ts";

export const piRouter = new Hono();

// TODO: Real implementation would:
// - POST /new: Create session via @mariozechner/pi-coding-agent SDK, return sessionId
// - POST /sessions/:id: Resume session and send concatenated prompt events

piRouter.post("/new", async (c) => {
  const { agentPath } = (await c.req.json()) as { agentPath: string; events?: IterateEvent[] };
  const sessionId = `pi-stub-${Date.now()}`;
  console.log(`[pi] Would create session for ${agentPath}`);
  return c.json({
    route: `/pi/sessions/${sessionId}`,
    sessionId,
    tui: `cd /workspace && pi --resume`,
  });
});

piRouter.post("/sessions/:sessionId", async (c) => {
  console.log(`[pi] Would send events to coding agent pi`);
  return c.json({ success: true, sessionId: c.req.param("sessionId") });
});
