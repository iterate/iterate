import { Hono } from "hono";
import type { IterateEvent } from "../types/events.ts";

export const codexRouter = new Hono();

// TODO: Real implementation would:
// - POST /new: Spawn `codex exec --json` and parse JSONL for session_id
// - POST /sessions/:id: Run `codex exec resume <id> --json <prompt>`

codexRouter.post("/new", async (c) => {
  const { agentPath } = (await c.req.json()) as { agentPath: string; events?: IterateEvent[] };
  const sessionId = `codex-stub-${Date.now()}`;
  console.log(`[codex] Would create session for ${agentPath}`);
  return c.json({
    route: `/codex/sessions/${sessionId}`,
    sessionId,
    tui: `codex resume ${sessionId} --all`,
  });
});

codexRouter.post("/sessions/:sessionId", async (c) => {
  console.log(`[codex] Would send events to coding agent codex`);
  return c.json({ success: true, sessionId: c.req.param("sessionId") });
});
