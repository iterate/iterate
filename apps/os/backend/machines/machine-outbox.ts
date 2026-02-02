import { and, eq, isNull } from "drizzle-orm";
import { env } from "../../env.ts";
import { getDb } from "../db/client.ts";
import * as schema from "../db/schema.ts";
import { captureServerEvent } from "../lib/posthog.ts";
import { createMachineProvider } from "../providers/index.ts";
import { logger } from "../tag-logger.ts";
import type { MachineLifecycleEventTypes } from "../outbox/event-types.ts";
import { getOrCreateProjectMachineToken } from "./machine-token.ts";

type MachineCreatedPayload = MachineLifecycleEventTypes["machine:created"];
type MachinePromotedPayload = MachineLifecycleEventTypes["machine:promoted"];

export async function handleMachineCreated(payload: MachineCreatedPayload): Promise<void> {
  const db = getDb();

  const [machine, project] = await Promise.all([
    db.query.machine.findFirst({
      where: and(
        eq(schema.machine.id, payload.machineId),
        eq(schema.machine.projectId, payload.projectId),
      ),
    }),
    db.query.project.findFirst({
      where: eq(schema.project.id, payload.projectId),
      with: { organization: true },
    }),
  ]);

  if (!machine) {
    throw new Error(`Machine not found for outbox event: ${payload.machineId}`);
  }

  if (!project) {
    throw new Error(`Project not found for outbox event: ${payload.projectId}`);
  }

  if (machine.externalId !== payload.machineId) {
    logger.info("Machine already provisioned, skipping", {
      machineId: payload.machineId,
      externalId: machine.externalId,
    });
    return;
  }

  const { apiKey } = await getOrCreateProjectMachineToken(db, payload.projectId);

  const globalEnvVars = await db.query.projectEnvVar.findMany({
    where: and(
      eq(schema.projectEnvVar.projectId, payload.projectId),
      isNull(schema.projectEnvVar.machineId),
    ),
  });

  const envVars = Object.fromEntries(globalEnvVars.map((envVar) => [envVar.key, envVar.value]));

  const provider = await createMachineProvider({
    type: payload.type,
    env,
    externalId: "", // Not known until create() returns
    metadata: payload.providerMetadata,
    buildProxyUrl: () => "",
  });

  const providerResult = await provider.create({
    machineId: payload.machineId,
    name: payload.name,
    envVars: {
      ...envVars,
      // Platform bootstrap env vars - we use the tunnel host if it is set to handle remote sandbox and local control plane use cases
      ITERATE_OS_BASE_URL: env.VITE_PUBLIC_URL,
      ITERATE_OS_API_KEY: apiKey,
      ITERATE_MACHINE_ID: payload.machineId,
      ITERATE_MACHINE_NAME: payload.name,
      // Org/project info for building dashboard URLs from within the sandbox
      ITERATE_ORG_ID: project.organizationId,
      ITERATE_ORG_SLUG: project.organization.slug,
      ITERATE_PROJECT_ID: project.id,
      ITERATE_PROJECT_SLUG: project.slug,
      // Egress proxy URL for sandbox mitmproxy (mounted on main worker)
      ITERATE_EGRESS_PROXY_URL: `${env.VITE_PUBLIC_URL}/api/egress-proxy`,
      // GitHub auth via egress proxy magic string - gh CLI sends this in Authorization header
      GH_TOKEN: `getIterateSecret({secretKey: "github.access_token"})`,
      GITHUB_TOKEN: `getIterateSecret({secretKey: "github.access_token"})`,
      // Note: git URL rewriting is configured in entry.sh via git config commands
      // In dev, use the current git branch for Daytona sandboxes
      ...(payload.type === "daytona" && env.ITERATE_DEV_GIT_REF
        ? { ITERATE_GIT_REF: env.ITERATE_DEV_GIT_REF }
        : {}),
    },
  });

  const mergedMetadata = {
    ...((machine.metadata as Record<string, unknown>) ?? {}),
    ...payload.providerMetadata,
    ...(providerResult.metadata ?? {}),
  };

  await db
    .update(schema.machine)
    .set({
      externalId: providerResult.externalId,
      metadata: mergedMetadata,
    })
    .where(eq(schema.machine.id, payload.machineId));

  await captureServerEvent(env, {
    distinctId: payload.createdByUserId,
    event: "machine_created",
    properties: {
      machine_id: payload.machineId,
      machine_type: payload.type,
      provider_external_id: providerResult.externalId,
    },
    groups: {
      organization: project.organizationId,
      project: project.id,
    },
  });
}

type ArchivedMachine = MachinePromotedPayload["archivedMachines"][number];

export async function archiveOldMachines(archivedMachines: ArchivedMachine[]): Promise<void> {
  for (const archivedMachine of archivedMachines) {
    const provider = await createMachineProvider({
      type: archivedMachine.type,
      env,
      externalId: archivedMachine.externalId,
      metadata: archivedMachine.metadata,
      buildProxyUrl: () => "",
    });

    await provider.archive();
  }
}

export async function handleMachinePromoted(payload: MachinePromotedPayload): Promise<void> {
  if (payload.archivedMachines.length === 0) {
    return;
  }

  await archiveOldMachines(payload.archivedMachines);
}
