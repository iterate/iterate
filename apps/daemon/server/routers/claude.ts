import { Hono } from "hono";
import type { IterateEvent } from "../types/events.ts";

export const claudeRouter = new Hono();

// TODO: Real implementation would:
// - POST /new: Create session via @anthropic-ai/claude-agent-sdk, return sessionId
// - POST /sessions/:id: Resume session with query({resume: sessionId, ...})

claudeRouter.post("/new", async (c) => {
  const { agentPath } = (await c.req.json()) as { agentPath: string; events?: IterateEvent[] };
  const sessionId = `claude-stub-${Date.now()}`;
  console.log(`[claude] Would create session for ${agentPath}`);
  return c.json({
    route: `/claude/sessions/${sessionId}`,
    sessionId,
    tui: `claude --resume ${sessionId}`,
  });
});

claudeRouter.post("/sessions/:sessionId", async (c) => {
  console.log(`[claude] Would send events to coding agent claude`);
  return c.json({ success: true, sessionId: c.req.param("sessionId") });
});
