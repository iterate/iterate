import { and, eq } from "drizzle-orm";
import { typeid } from "typeid-js";
import type { AgentInitParams, IterateAgent } from "../iterate-agent.ts";
import { agentInstance, agentInstanceRoute } from "../../db/schema.ts";
import type { DB } from "../../db/client.ts";
import type { IterateConfig } from "../../../sdk/iterate-config.ts";
import { env, type CloudflareEnv } from "../../../env.ts";

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

export type GetStubParams = {
  agentInitParams: AgentInitParams;
  jurisdiction?: DurableObjectJurisdiction;
  locationHint?: DurableObjectLocationHint;
};

export type GetStubByNameParams = {
  db: DB;
  agentInstanceName: string;
};

export type GetStubsByRouteParams = {
  db: DB;
  routingKey: string;
  estateId?: string;
};

export type GetOrCreateStubByNameParams = {
  db: DB;
  estateId: string;
  agentInstanceName: string;
  reason?: string;
};

export type GetOrCreateStubByRouteParams = {
  db: DB;
  estateId: string;
  route: string;
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
  params: GetStubParams,
): Promise<DurableObjectStub<IterateAgent>> {
  const { agentInitParams, jurisdiction, locationHint } = params;
  let namespace = getNamespaceForClassName(className);

  if (jurisdiction) {
    namespace = namespace.jurisdiction(jurisdiction);
  }

  const options = {
    ...(locationHint && { locationHint }),
  };

  const stub = namespace.getByName(agentInitParams.record.durableObjectName, options);

  await stub.initIterateAgent(agentInitParams);

  // @ts-expect-error, fix this infinite type error
  return stub;
}

export async function getAgentStubByName(
  className: AgentClassName,
  params: GetStubByNameParams,
): Promise<DurableObjectStub<IterateAgent>> {
  const { db, agentInstanceName } = params;

  const row = await db.query.agentInstance.findFirst({
    where: and(
      eq(agentInstance.durableObjectName, agentInstanceName),
      eq(agentInstance.className, className),
    ),
    with: {
      estate: {
        with: {
          organization: true,
          iterateConfigs: true,
        },
      },
    },
  });

  if (!row) {
    throw new Error(`Agent instance ${agentInstanceName} not found`);
  }

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

export async function getAgentStubsByRoute(
  className: AgentClassName,
  params: GetStubsByRouteParams,
): Promise<DurableObjectStub<IterateAgent>[]> {
  const { db, routingKey, estateId } = params;

  const routes = await db.query.agentInstanceRoute.findMany({
    where: eq(agentInstanceRoute.routingKey, routingKey),
    with: {
      agentInstance: {
        with: {
          estate: {
            with: {
              organization: true,
              iterateConfigs: true,
            },
          },
        },
      },
    },
  });

  const matchingAgents = routes
    .map((r) => r.agentInstance)
    .filter((r) => r.className === className && (!estateId || r.estateId === estateId));

  if (matchingAgents.length > 1) {
    throw new Error(`Multiple agents found for routing key ${routingKey}`);
  }

  const stubs = await Promise.all(
    matchingAgents.map(async (row) => {
      const { estate: estateJoined, ...record } = row;
      const iterateConfig: IterateConfig = estateJoined.iterateConfigs?.[0]?.config ?? {};
      return getAgentStub(className, {
        agentInitParams: {
          record,
          estate: estateJoined,
          organization: estateJoined.organization!,
          iterateConfig,
        },
      });
    }),
  );

  return stubs as unknown as DurableObjectStub<IterateAgent>[];
}

export async function getOrCreateAgentStubByName(
  className: AgentClassName,
  params: GetOrCreateStubByNameParams,
): Promise<DurableObjectStub<IterateAgent>> {
  const { db, estateId, agentInstanceName, reason } = params;

  const existing = await db.query.agentInstance.findFirst({
    where: and(
      eq(agentInstance.durableObjectName, agentInstanceName),
      eq(agentInstance.className, className),
      eq(agentInstance.estateId, estateId),
    ),
    with: {
      estate: {
        with: {
          organization: true,
          iterateConfigs: true,
        },
      },
    },
  });

  if (existing) {
    const { estate: estateJoined, ...record } = existing;
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

  const namespace = getNamespaceForClassName(className);
  const durableObjectId = namespace.idFromName(agentInstanceName);

  const [inserted] = await db
    .insert(agentInstance)
    .values({
      estateId,
      className,
      durableObjectName: agentInstanceName,
      durableObjectId: durableObjectId.toString(),
      metadata: { reason },
    })
    .onConflictDoUpdate({
      target: agentInstance.durableObjectId,
      set: {
        metadata: { reason },
      },
    })
    .returning();

  const row = await db.query.agentInstance.findFirst({
    where: eq(agentInstance.id, inserted.id),
    with: {
      estate: {
        with: {
          organization: true,
          iterateConfigs: true,
        },
      },
    },
  });

  if (!row) {
    throw new Error(`Failed to fetch created agent instance ${agentInstanceName}`);
  }

  if (row.estateId !== estateId) {
    throw new Error(`Agent instance ${agentInstanceName} already exists in a different estate`);
  }

  const { estate: estateJoined, ...record } = row;
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
  params: GetOrCreateStubByRouteParams,
): Promise<DurableObjectStub<IterateAgent>> {
  const { db, estateId, route, reason } = params;

  const existingRoutes = await db.query.agentInstanceRoute.findMany({
    where: eq(agentInstanceRoute.routingKey, route),
    with: {
      agentInstance: {
        with: {
          estate: {
            with: {
              organization: true,
              iterateConfigs: true,
            },
          },
        },
      },
    },
  });

  const existingAgent = existingRoutes
    .map((r) => r.agentInstance)
    .find((r) => r.className === className && r.estateId === estateId);

  if (existingAgent) {
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

  const namespace = getNamespaceForClassName(className);
  const durableObjectName = `${className}-${route}-${typeid().toString()}`;
  const durableObjectId = namespace.idFromName(durableObjectName);

  const insertedId = await db.transaction(async (tx) => {
    const [inserted] = await tx
      .insert(agentInstance)
      .values({
        estateId,
        className,
        durableObjectName,
        durableObjectId: durableObjectId.toString(),
        metadata: { reason },
      })
      .onConflictDoUpdate({
        target: agentInstance.durableObjectId,
        set: {
          metadata: { reason },
        },
      })
      .returning();

    await tx
      .insert(agentInstanceRoute)
      .values({ agentInstanceId: inserted.id, routingKey: route })
      .onConflictDoNothing();

    return inserted.id;
  });

  const row = await db.query.agentInstance.findFirst({
    where: eq(agentInstance.id, insertedId),
    with: {
      estate: {
        with: {
          organization: true,
          iterateConfigs: true,
        },
      },
    },
  });

  if (!row) {
    throw new Error(`Failed to fetch created agent instance ${durableObjectName}`);
  }

  const { estate: estateJoined, ...record } = row;
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
