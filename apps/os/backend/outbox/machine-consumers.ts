import { logger } from "../tag-logger.ts";
import { captureServerEvent } from "../lib/posthog.ts";
import { env } from "../../env.ts";
import { createMachineProvider } from "../providers/index.ts";
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

  cc.registerConsumer({
    name: "handleMachinePromoted",
    on: "machine:promoted",
    handler: async ({ payload }) => {
      const { promotedMachineId, archivedMachines } = payload;

      logger.info("Processing machine promotion archival", {
        promotedMachineId,
        archivedCount: archivedMachines.length,
      });

      // Archive each machine via provider
      for (const machine of archivedMachines) {
        try {
          const provider = await createMachineProvider({
            type: machine.type,
            env,
            externalId: machine.externalId,
            metadata: machine.metadata,
            buildProxyUrl: () => "",
          });

          await provider.archive();

          logger.info("Archived machine via provider", {
            machineId: machine.id,
            promotedMachineId,
          });
        } catch (err) {
          logger.error("Failed to archive machine via provider", {
            machineId: machine.id,
            promotedMachineId,
            err,
          });
          // Rethrow to trigger retry via outbox
          throw err;
        }
      }

      return "archived_machines";
    },
  });
}
