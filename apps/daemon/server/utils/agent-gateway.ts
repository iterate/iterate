import { and, eq, isNull } from "drizzle-orm";
import { db } from "../db/index.ts";
import * as schema from "../db/schema.ts";
import type { IterateEvent } from "../types/events.ts";

const DAEMON_PORT = process.env.PORT || "3001";
const DAEMON_BASE_URL = `http://localhost:${DAEMON_PORT}`;

export async function activeAgentExists(agentPath: string): Promise<boolean> {
  const existing = await db
    .select()
    .from(schema.agents)
    .where(and(eq(schema.agents.path, agentPath), isNull(schema.agents.archivedAt)))
    .limit(1);
  return Boolean(existing[0]);
}

export async function sendToAgentGateway(agentPath: string, event: IterateEvent): Promise<void> {
  const response = await fetch(`${DAEMON_BASE_URL}/api/agents${agentPath}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(event),
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => "");
    throw new Error(
      `Agent gateway failed: ${response.status}${errorBody ? ` ${errorBody.slice(0, 500)}` : ""}`,
    );
  }
}

export async function sendPromptToAgent(agentPath: string, message: string): Promise<void> {
  await sendToAgentGateway(agentPath, { type: "prompt", message });
}
