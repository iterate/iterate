import { eq, and, lt } from "drizzle-orm";
import { getDb } from "../db/client.ts";
import * as schema from "../db/schema.ts";
import { logger } from "../tag-logger.ts";
import { env } from "../../env.ts";
import { createMachineProvider } from "../providers/index.ts";
import { outboxClient as cc } from "./client.ts";

export const registerConsumers = () => {
  registerTestConsumers();

  // Step 2: When a machine is activated, find stale detached machines and fan out archive events
  cc.registerConsumer({
    name: "archiveStaleDetachedMachines",
    on: "machine:activated",
    async handler(params) {
      const { projectId, machineId } = params.payload;
      const db = getDb();

      const detachedCleanupCutoff = new Date(Date.now() - 48 * 60 * 60 * 1000);
      const staleDetached = await db.query.machine.findMany({
        where: and(
          eq(schema.machine.projectId, projectId),
          eq(schema.machine.state, "detached"),
          lt(schema.machine.updatedAt, detachedCleanupCutoff),
        ),
      });

      for (const m of staleDetached) {
        await cc.send({ transaction: db, parent: db }, "machine:archive", {
          machineId: m.id,
          type: m.type,
          externalId: m.externalId,
          metadata: m.metadata ?? {},
        });
      }

      logger.info("[outbox] Fan-out archival for stale detached machines", {
        activatedMachineId: machineId,
        projectId,
        enqueuedCount: staleDetached.length,
      });
      return `enqueued ${staleDetached.length} machine:archive events`;
    },
  });

  // Step 3: Archive a single machine via the provider SDK (e.g. Daytona)
  cc.registerConsumer({
    name: "archiveMachineViaProvider",
    on: "machine:archive",
    async handler(params) {
      const { machineId, type, externalId, metadata } = params.payload;
      const db = getDb();

      const provider = await createMachineProvider({
        type,
        env,
        externalId,
        metadata,
        buildProxyUrl: () => "",
      });
      await provider.archive();

      await db
        .update(schema.machine)
        .set({ state: "archived" })
        .where(eq(schema.machine.id, machineId));

      logger.info("[outbox] Archived machine via provider", { machineId });
      return `archived machine ${machineId}`;
    },
  });
};

/** Test consumers for e2e tests: queueing, retries, DLQ */
function registerTestConsumers() {
  cc.registerConsumer({
    name: "logPoke",
    on: "testing:poke",
    handler: (params) => {
      logger.info(`[outbox] GOT: ${params.eventName}, message: ${params.payload.message}`);
      return "received message: " + params.payload.message;
    },
  });

  cc.registerConsumer({
    name: "logGreeting",
    on: "trpc:admin.outbox.poke",
    when: (params) => params.payload.input.message.includes("hi"),
    handler: (params) => {
      logger.info(
        `[outbox] GOT: ${params.eventName}, server reply: ${params.payload.output.reply}`,
      );
      return "logged it";
    },
  });

  cc.registerConsumer({
    name: "unstableConsumer",
    on: "trpc:admin.outbox.poke",
    when: (params) => params.payload.input.message.includes("unstable"),
    handler: (params) => {
      if (params.job.attempt > 2) {
        return "third time lucky";
      }
      throw new Error(`[test_error] Attempt ${params.job.attempt} failed ${Math.random()}`);
    },
  });

  cc.registerConsumer({
    name: "badConsumer",
    on: "trpc:admin.outbox.poke",
    retry: (job) => {
      if (job.read_ct <= 5) return { retry: true, reason: "always retry", delay: 1 };
      return { retry: false, reason: "max retries reached" };
    },
    when: (params) => params.payload.input.message.includes("fail"),
    handler: (params) => {
      throw new Error(`[test_error] Attempt ${params.job.attempt} failed ${Math.random()}`);
    },
  });
}
