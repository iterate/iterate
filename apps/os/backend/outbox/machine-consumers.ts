import { logger } from "../tag-logger.ts";
import { captureServerEvent } from "../lib/posthog.ts";
import { env } from "../../env.ts";
import { outboxClient as cc } from "./client.ts";

export function registerMachineConsumers() {
  cc.registerConsumer({
    name: "handleMachineCreated",
    on: "machine:created",
    handler: async ({ payload }) => {
      const { machineId, projectId, name, type, externalId } = payload;

      // Track machine creation in PostHog
      await captureServerEvent(env, {
        distinctId: `machine:${machineId}`,
        event: "machine_created",
        properties: {
          machine_id: machineId,
          project_id: projectId,
          machine_name: name,
          machine_type: type,
          external_id: externalId,
        },
        groups: { project: projectId },
      });

      logger.info("Machine created", {
        machineId,
        projectId,
        name,
        type,
        externalId,
      });

      return "machine_created";
    },
  });
}
