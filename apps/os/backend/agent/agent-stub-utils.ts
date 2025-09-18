import { getAgentByName } from "agents";
import { eq, and } from "drizzle-orm";
import { env } from "../../env.ts";
import type { IterateAgent, SlackAgent } from "../worker.ts";
import type { DB } from "../db/client.ts";
import * as schema from "../db/schema.ts";

type AgentClassName = "IterateAgent" | "SlackAgent";

function getNamespaceForClass(className: "SlackAgent"): DurableObjectNamespace<SlackAgent>;
function getNamespaceForClass(className: "IterateAgent"): DurableObjectNamespace<IterateAgent>;
function getNamespaceForClass(className: AgentClassName) {
  switch (className) {
    case "SlackAgent":
      return env.SLACK_AGENT;
    case "IterateAgent":
      return env.ITERATE_AGENT;
  }
}

export async function createAgent(
  db: DB,
  params: {
    estateId: string;
    className: AgentClassName;
    durableObjectName: string;
    metadata?: Record<string, unknown>;
    routingKeys?: string[];
    reason?: string;
  },
) {
  const { estateId, className, durableObjectName, metadata, routingKeys, reason } = params;
  // Narrow by className for correct namespace typing
  const id =
    className === "SlackAgent"
      ? getNamespaceForClass("SlackAgent").idFromName(durableObjectName)
      : getNamespaceForClass("IterateAgent").idFromName(durableObjectName);
  const durableObjectId = id.toString();

  const mergedMetadata = { ...(metadata || {}), ...(reason ? { reason } : {}) } as Record<
    string,
    unknown
  >;

  await db
    .insert(schema.agentDurableObjects)
    .values({
      estateId,
      className,
      durableObjectName,
      durableObjectId,
      metadata: mergedMetadata,
    })
    .onConflictDoNothing();

  const record = await db.query.agentDurableObjects.findFirst({
    where: and(
      eq(schema.agentDurableObjects.durableObjectName, durableObjectName),
      eq(schema.agentDurableObjects.className, className),
    ),
  });

  if (!record) {
    throw new Error("Failed to upsert agent durable object record");
  }

  if (routingKeys && routingKeys.length > 0) {
    await db
      .insert(schema.agentDurableObjectRoutes)
      .values(
        routingKeys.map((routingKey) => ({
          routingKey,
          agentDurableObjectId: record.id,
        })),
      )
      .onConflictDoNothing();
  }

  const stub = await (className === "SlackAgent"
    ? getAgentByName(getNamespaceForClass("SlackAgent"), durableObjectName)
    : getAgentByName(getNamespaceForClass("IterateAgent"), durableObjectName));
  // Best-effort: inform the agent about its database record
  try {
    await stub.setDatabaseRecord({
      persistedId: record.id,
      estateId: record.estateId,
      className: record.className,
      durableObjectName: record.durableObjectName,
      durableObjectId: record.durableObjectId,
      metadata: record.metadata ?? {},
    });
  } catch (err) {
    console.warn("Failed to set database record on agent", err);
  }
  return { stub, record } as const;
}

export async function listAgents(
  db: DB,
  params: { estateId: string; className?: AgentClassName; routingKey?: string },
) {
  const { estateId, className, routingKey } = params;

  if (routingKey) {
    const routes = await db.query.agentDurableObjectRoutes.findMany({
      where: eq(schema.agentDurableObjectRoutes.routingKey, routingKey),
      with: { agentDurableObject: true },
    });
    return routes
      .map((r) => r.agentDurableObject)
      .filter((r) => !!r && r.estateId === estateId && (!className || r.className === className));
  }

  return await db.query.agentDurableObjects.findMany({
    where: and(
      eq(schema.agentDurableObjects.estateId, estateId),
      ...(className ? [eq(schema.agentDurableObjects.className, className)] : []),
    ),
  });
}

export async function getAgentStub(
  db: DB,
  params: {
    estateId: string;
    className: AgentClassName;
    durableObjectName?: string;
    durableObjectId?: string;
    reason?: string;
    createIfNotExists?: boolean;
    metadata?: Record<string, unknown>;
    routingKeys?: string[];
  },
) {
  const { estateId, className, durableObjectName, durableObjectId } = params;

  const lookupByName = async (name: string) =>
    await db.query.agentDurableObjects.findFirst({
      where: eq(schema.agentDurableObjects.durableObjectName, name),
    });
  const lookupById = async (id: string) =>
    await db.query.agentDurableObjects.findFirst({
      where: eq(schema.agentDurableObjects.durableObjectId, id),
    });

  const record = durableObjectId
    ? await lookupById(durableObjectId)
    : durableObjectName
      ? await lookupByName(durableObjectName)
      : null;

  if (!record) {
    if (params.createIfNotExists && durableObjectName) {
      const created = await createAgent(db, {
        estateId,
        className,
        durableObjectName,
        metadata: params.metadata,
        routingKeys: params.routingKeys,
        reason: params.reason,
      });
      return created.stub;
    }
    throw new Error("Agent durable object not found");
  }

  // Ensure class and estate constraints match
  if (record.estateId !== estateId) {
    throw new Error("Agent belongs to a different estate");
  }
  if (record.className !== className) {
    throw new Error("Agent class mismatch");
  }

  const stub = await (className === "SlackAgent"
    ? getAgentByName(getNamespaceForClass("SlackAgent"), record.durableObjectName)
    : getAgentByName(getNamespaceForClass("IterateAgent"), record.durableObjectName));
  try {
    await stub.setDatabaseRecord({
      persistedId: record.id,
      estateId: record.estateId,
      className: record.className,
      durableObjectName: record.durableObjectName,
      durableObjectId: record.durableObjectId,
      metadata: record.metadata ?? {},
    });
  } catch (err) {
    console.warn("Failed to set database record on agent", err);
  }
  return stub;
}
