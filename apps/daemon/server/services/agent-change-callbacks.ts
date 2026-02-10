import { and, eq } from "drizzle-orm";
import { db } from "../db/index.ts";
import * as schema from "../db/schema.ts";

type SerializedAgentRoute = {
  id: number;
  agentPath: string;
  destination: string;
  active: boolean;
  metadata: Record<string, unknown> | null;
  createdAt: string | null;
  updatedAt: string | null;
};

type AgentChangePayload = {
  path: string;
  workingDirectory: string;
  metadata: Record<string, unknown> | null;
  shortStatus: string;
  isWorking: boolean;
  createdAt: string | null;
  updatedAt: string | null;
  archivedAt: string | null;
  activeRoute: SerializedAgentRoute | null;
};

export async function loadAgentChangePayload(
  agentPath: string,
): Promise<AgentChangePayload | null> {
  const rows = await db
    .select({ agent: schema.agents, route: schema.agentRoutes })
    .from(schema.agents)
    .leftJoin(
      schema.agentRoutes,
      and(
        eq(schema.agentRoutes.agentPath, schema.agents.path),
        eq(schema.agentRoutes.active, true),
      ),
    )
    .where(eq(schema.agents.path, agentPath))
    .limit(1);
  const row = rows[0];
  if (!row) return null;

  return {
    ...row.agent,
    createdAt: row.agent.createdAt?.toISOString() ?? null,
    updatedAt: row.agent.updatedAt?.toISOString() ?? null,
    archivedAt: row.agent.archivedAt?.toISOString() ?? null,
    activeRoute: row.route
      ? {
          ...row.route,
          createdAt: row.route.createdAt?.toISOString() ?? null,
          updatedAt: row.route.updatedAt?.toISOString() ?? null,
        }
      : null,
  };
}

export async function notifyAgentChange(agentPath: string): Promise<void> {
  const payload = await loadAgentChangePayload(agentPath);
  if (!payload) return;

  const subscriptions = await db
    .select()
    .from(schema.agentSubscriptions)
    .where(eq(schema.agentSubscriptions.agentPath, agentPath));

  for (const subscription of subscriptions) {
    void fetch(subscription.callbackUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    }).catch((error) => {
      console.error("[agent-change-callback] callback failed", {
        agentPath,
        callbackUrl: subscription.callbackUrl,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }
}
