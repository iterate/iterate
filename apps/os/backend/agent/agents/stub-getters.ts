import { and, eq } from "drizzle-orm";
import { typeid } from "typeid-js";
import type { AgentInitParams, IterateAgent } from "../iterate-agent.ts";
import { agentInstance } from "../../db/schema.ts";
import { schema, type DB } from "../../db/client.ts";
import type { IterateConfig } from "../../../sdk/iterate-config.ts";
import { env, type CloudflareEnv } from "../../../env.ts";
import { logger } from "../../tag-logger.ts";
import { stubStub } from "../../stub-stub.ts";

// NOTE: This indirection is intentionally string-based. It's admittedly hacky,
// but acceptable until we can collapse all IterateAgent subclasses into a
// single durable object with runtime-loadable facets sourced from
// iterate.config.ts. At that point we can remove this manual binding lookup.

export const AGENT_CLASS_NAMES = ["IterateAgent", "SlackAgent", "OnboardingAgent"] as const;

export type AgentClassName = (typeof AGENT_CLASS_NAMES)[number];

export function toAgentClassName(value: string): AgentClassName {
  if ((AGENT_CLASS_NAMES as readonly string[]).includes(value)) {
    return value as AgentClassName;
  }

  throw new Error(
    `Unknown IterateAgent subclass "${value}". Known classes: ${AGENT_CLASS_NAMES.join(", ")}`,
  );
}

export type GetOrCreateStubByNameParams = {
  db: DB;
  estateId: string;
  agentInstanceName: string;
  reason?: string;
};

function toConstantCase(value: string) {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[-\s]/g, "_")
    .toUpperCase();
}

type AgentNamespace = typeof env.ITERATE_AGENT;

function getNamespaceForClassName(className: AgentClassName): AgentNamespace {
  const namespaceKey = toConstantCase(className);
  const namespaceCandidate = env[namespaceKey as keyof CloudflareEnv];

  if (
    !namespaceCandidate ||
    typeof namespaceCandidate !== "object" ||
    typeof (namespaceCandidate as AgentNamespace).idFromName !== "function"
  ) {
    throw new Error(
      `No Durable Object namespace found for IterateAgent subclass "${className}". ` +
        `Expected env.${namespaceKey} to be bound to the ${className} durable object. ` +
        "Please ensure IterateAgent subclass names align with worker bindings.",
    );
  }

  return namespaceCandidate as AgentNamespace;
}

export async function getAgentStub(
  className: AgentClassName,
  params: { agentInitParams: AgentInitParams },
) {
  const { agentInitParams } = params;
  const namespace = getNamespaceForClassName(className);

  const doStub = namespace.getByName(agentInitParams.record.durableObjectName);
  const doStubStub = stubStub(doStub as {} as IterateAgent, {
    className,
    durableObjectName: agentInitParams.record.durableObjectName,
    estateId: agentInitParams.record.estateId,
    ...logger.tags,
  });

  await doStubStub.initIterateAgent(agentInitParams);

  return doStubStub;
}

export async function getAgentStubByName(
  className: AgentClassName,
  params: { db: DB; agentInstanceName: string; estateId?: string },
) {
  const { db, agentInstanceName } = params;

  const row = await db.query.agentInstance.findFirst({
    where: and(
      eq(agentInstance.durableObjectName, agentInstanceName),
      eq(agentInstance.className, className),
      eq(agentInstance.estateId, params.estateId || agentInstance.estateId), // todo: make estateId required? seems safer. but we have lots of calls of this already, so will do separately
    ),
    with: { estate: { with: { organization: true, iterateConfigs: true } } },
  });

  if (!row) throw new Error(`Agent instance ${agentInstanceName} not found`);

  const { estate: estateJoined, ...record } = row;

  if (!estateJoined) {
    throw new Error(`Estate ${record.estateId} not found for agent ${record.id}`);
  }

  const iterateConfig: IterateConfig = estateJoined.iterateConfigs?.[0]?.config ?? {};

  return getAgentStub(className, {
    agentInitParams: {
      record,
      estate: estateJoined,
      organization: estateJoined.organization!,
      iterateConfig,
    },
  });
}

export async function getOrCreateAgentStubByRoute(
  className: AgentClassName,
  params: { db: DB; estateId: string; route: string; reason?: string },
) {
  const { db, estateId, route, reason } = params;

  const namespace = getNamespaceForClassName(className);
  const durableObjectName = `${className}-${route}-${typeid().toString()}`;
  const durableObjectId = namespace.idFromName(durableObjectName);

  // insert if the routing key doesn't yet exist
  await db
    .insert(schema.agentInstance)
    .values({
      estateId,
      className,
      durableObjectName,
      durableObjectId: durableObjectId.toString(),
      metadata: { reason },
      routingKey: route,
    })
    .onConflictDoNothing({ target: schema.agentInstance.routingKey });

  const existingAgent = await db.query.agentInstance.findFirst({
    where: eq(agentInstance.routingKey, route),
    with: { estate: { with: { organization: true, iterateConfigs: true } } },
  });

  if (!existingAgent) throw new Error(`No agent at ${route} - we should have just inserted it!`);

  const { estate: estateJoined, ...record } = existingAgent;
  const iterateConfig: IterateConfig = estateJoined.iterateConfigs?.[0]?.config ?? {};
  return getAgentStub(className, {
    agentInitParams: {
      record,
      estate: estateJoined,
      organization: estateJoined.organization!,
      iterateConfig,
    },
  });
}
