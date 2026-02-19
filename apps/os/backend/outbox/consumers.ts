import { eq, and, lt } from "drizzle-orm";
import { createMachineStub } from "@iterate-com/sandbox/providers/machine-stub";
import { getDb } from "../db/client.ts";
import * as schema from "../db/schema.ts";
import { logger } from "../tag-logger.ts";
import { env } from "../../env.ts";
import {
  buildMachineFetcher,
  sendProbeMessage,
  pollForProbeAnswer,
} from "../services/machine-readiness-probe.ts";
import { buildMachineEnvVars } from "../services/machine-creation.ts";
import { stripMachineStateMetadata } from "../utils/machine-metadata.ts";
import { broadcastInvalidation } from "../utils/query-invalidation.ts";
import { outboxClient as cc } from "./client.ts";

export const registerConsumers = () => {
  registerTestConsumers();

  // ── Provisioning pipeline ──────────────────────────────────────────────
  //
  // machine:created → provisionMachine
  // (daemon reports status via reportStatus → machine:daemon-status-reported → probe pipeline)

  cc.registerConsumer({
    name: "provisionMachine",
    on: "machine:created",
    visibilityTimeout: 300, // provisioning can take minutes (Daytona snapshot, etc.)
    retry: (job) => {
      if (job.read_ct <= 2) return { retry: true, reason: "retrying provisioning", delay: 10 };
      return { retry: false, reason: "provisioning failed after retries" };
    },
    async handler(params) {
      const { machineId } = params.payload;
      const db = getDb();

      const machine = await db.query.machine.findFirst({
        where: eq(schema.machine.id, machineId),
        with: { project: { with: { organization: true } } },
      });
      if (!machine) throw new Error(`Machine ${machineId} not found`);

      if (machine.state !== "starting") {
        logger.info("[provisionMachine] Skipping, machine no longer starting", {
          machineId,
          state: machine.state,
        });
        return `skipped: machine state is ${machine.state}`;
      }

      if (!machine.externalId) throw new Error(`Machine ${machineId} has no externalId`);

      const { apiKey } = await import("../services/machine-creation.ts").then((mod) =>
        mod.getOrCreateProjectMachineToken(db, machine.projectId),
      );
      const fullEnvVars = await buildMachineEnvVars({
        db,
        env,
        projectId: machine.projectId,
        organizationId: machine.project.organizationId,
        organizationSlug: machine.project.organization.slug,
        projectSlug: machine.project.slug,
        machineId,
        name: machine.name,
        apiKey,
      });

      const initialMetadata = stripMachineStateMetadata(
        (machine.metadata as Record<string, unknown>) ?? {},
      );

      const runtime = await createMachineStub({
        type: machine.type,
        env,
        externalId: machine.externalId,
        metadata: initialMetadata,
      });
      const runtimeResult = await runtime.create({
        machineId,
        externalId: machine.externalId,
        name: machine.name,
        envVars: fullEnvVars,
      });

      // Merge provider metadata with any metadata written while provisioning ran
      const latestMachine = await db.query.machine.findFirst({
        where: eq(schema.machine.id, machineId),
      });
      const latestMetadata = (latestMachine?.metadata as Record<string, unknown>) ?? {};
      const mergedMetadata = {
        ...stripMachineStateMetadata(latestMetadata),
        ...(runtimeResult.metadata ?? {}),
      };

      await db
        .update(schema.machine)
        .set({ metadata: mergedMetadata })
        .where(eq(schema.machine.id, machineId));

      logger.info("[provisionMachine] Machine provisioned", {
        machineId,
        type: machine.type,
      });
      return `provisioned machine ${machineId}`;
    },
  });

  // ── Readiness probe pipeline ──────────────────────────────────────────
  //
  // daemon-status-reported → sendReadinessProbe (guarded) → (probe-sent)
  //   → pollProbeResponse → (probe-succeeded) → activateMachine → (activated)
  //   → (probe-failed) → markMachineProbeFailure

  // Stage 1: Daemon reported status — if ready + provisioned, send the probe message.
  // `when` skips the consumer entirely (not even enqueued) for non-ready / unprovisioned reports.
  cc.registerConsumer({
    name: "sendReadinessProbe",
    on: "machine:daemon-status-reported",
    when: (params) => params.payload.status === "ready" && !!params.payload.externalId,
    visibilityTimeout: 90, // send retries up to 60s + margin
    delay: () => 60, // opencode needs some time to restart after env vars are applied. Around 30s, so delay 60s to be safe.
    retry: (job) => {
      if (job.read_ct <= 2) return { retry: true, reason: "retrying probe send", delay: 15 };
      return { retry: false, reason: "probe send failed after retries" };
    },
    async handler(params) {
      const { machineId, projectId } = params.payload;
      const db = getDb();

      const machine = await db.query.machine.findFirst({
        where: eq(schema.machine.id, machineId),
      });
      if (!machine) throw new Error(`Machine ${machineId} not found`);

      if (machine.state !== "starting") {
        logger.info("[sendReadinessProbe] Skipping, machine no longer starting", {
          machineId,
          state: machine.state,
        });
        return `skipped: machine state is ${machine.state}`;
      }

      const fetcher = await buildMachineFetcher(machine, env);
      if (!fetcher) {
        throw new Error(`Could not build fetcher for machine ${machineId}`);
      }

      const sendResult = await sendProbeMessage(fetcher);
      if (!sendResult.ok) {
        throw new Error(`probe send failed: ${sendResult.detail}`);
      }

      // Probe message sent successfully — emit probe-sent so polling begins
      await cc.send({ transaction: db, parent: db }, "machine:probe-sent", {
        machineId,
        projectId,
        threadId: sendResult.threadId,
        messageId: sendResult.messageId,
      });

      logger.info("[sendReadinessProbe] Probe message sent", {
        machineId,
        threadId: sendResult.threadId,
        messageId: sendResult.messageId,
      });
      return `probe sent, messageId=${sendResult.messageId}`;
    },
  });

  // Stage 2: Probe message was sent — poll for a valid response.
  cc.registerConsumer({
    name: "pollProbeResponse",
    on: "machine:probe-sent",
    visibilityTimeout: 150, // poll runs up to 120s + margin
    retry: (job) => {
      // Polling itself already retries internally for 120s. An outbox retry here
      // covers worker-level failures (e.g. worker restarted mid-poll).
      if (job.read_ct <= 1) return { retry: true, reason: "retrying poll", delay: 10 };
      return { retry: false, reason: "poll failed after retry" };
    },
    async handler(params) {
      const { machineId, projectId, threadId } = params.payload;
      const db = getDb();

      const machine = await db.query.machine.findFirst({
        where: eq(schema.machine.id, machineId),
      });
      if (!machine) throw new Error(`Machine ${machineId} not found`);

      if (machine.state !== "starting") {
        logger.info("[pollProbeResponse] Skipping, machine no longer starting", {
          machineId,
          state: machine.state,
        });
        return `skipped: machine state is ${machine.state}`;
      }

      const fetcher = await buildMachineFetcher(machine, env);
      if (!fetcher) {
        throw new Error(`Could not build fetcher for machine ${machineId}`);
      }

      const pollResult = await pollForProbeAnswer(fetcher, threadId);

      if (pollResult.ok) {
        await cc.send({ transaction: db, parent: db }, "machine:probe-succeeded", {
          machineId,
          projectId,
          responseText: pollResult.responseText,
        });

        logger.info("[pollProbeResponse] Probe succeeded", {
          machineId,
          responseText: pollResult.responseText,
        });
        return `probe succeeded: "${pollResult.responseText}"`;
      }

      // Probe failed — emit failure event (don't throw, the failure is a fact to record)
      await cc.send({ transaction: db, parent: db }, "machine:probe-failed", {
        machineId,
        projectId,
        detail: pollResult.detail,
        attempt: params.job.attempt,
      });

      logger.error("[pollProbeResponse] Probe failed", {
        machineId,
        detail: pollResult.detail,
        attempt: params.job.attempt,
      });
      return `probe failed: ${pollResult.detail}`;
    },
  });

  // Stage 3a: Probe succeeded — activate the machine.
  cc.registerConsumer({
    name: "activateMachine",
    on: "machine:probe-succeeded",
    async handler(params) {
      const { machineId, projectId } = params.payload;
      const db = getDb();

      const machine = await db.query.machine.findFirst({
        where: eq(schema.machine.id, machineId),
      });
      if (!machine) throw new Error(`Machine ${machineId} not found`);

      if (machine.state !== "starting") {
        logger.info("[activateMachine] Skipping, machine no longer starting", {
          machineId,
          state: machine.state,
        });
        return `skipped: machine state is ${machine.state}`;
      }

      const activated = await db.transaction(async (tx) => {
        // Re-check state inside the transaction (TOCTOU protection)
        const current = await tx.query.machine.findFirst({
          where: eq(schema.machine.id, machineId),
        });
        if (current?.state !== "starting") {
          logger.info("[activateMachine] Skipping inside tx, state changed", {
            machineId,
            state: current?.state,
          });
          return;
        }

        // Bulk-detach all active machines for this project
        await tx
          .update(schema.machine)
          .set({ state: "detached" })
          .where(and(eq(schema.machine.projectId, projectId), eq(schema.machine.state, "active")));

        // Promote this machine to active
        await tx
          .update(schema.machine)
          .set({ state: "active" })
          .where(eq(schema.machine.id, machineId));

        // Emit activated event inside the transaction for atomicity
        await cc.send({ transaction: tx, parent: db }, "machine:activated", {
          machineId,
          projectId,
        });

        return true as const;
      });

      if (!activated) {
        return `skipped: state changed during transaction`;
      }

      logger.info("[activateMachine] Machine activated", { machineId });
      await broadcastInvalidation(env).catch(() => {});
      return `machine activated`;
    },
  });

  // Stage 3b: Probe failed — mark the machine as errored.
  cc.registerConsumer({
    name: "markMachineProbeFailure",
    on: "machine:probe-failed",
    async handler(params) {
      const { machineId, detail } = params.payload;
      const db = getDb();

      const machine = await db.query.machine.findFirst({
        where: eq(schema.machine.id, machineId),
      });
      if (!machine) throw new Error(`Machine ${machineId} not found`);

      if (machine.state !== "starting") {
        return `skipped: machine state is ${machine.state}`;
      }

      await broadcastInvalidation(env).catch(() => {});
      logger.error("[markMachineProbeFailure] Machine probe failed", { machineId, detail });
      return `marked as error: ${detail}`;
    },
  });

  // ── Post-activation pipeline ──────────────────────────────────────────

  // When a machine is activated, find stale detached machines and fan out archive events
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
        await cc.send({ transaction: db, parent: db }, "machine:archive-requested", {
          machineId: m.id,
          type: m.type,
          externalId: m.externalId,
          metadata: m.metadata ?? {},
        });
      }

      logger.info("[archiveStaleDetachedMachines] Fan-out archival", {
        activatedMachineId: machineId,
        projectId,
        enqueuedCount: staleDetached.length,
      });
      return `enqueued ${staleDetached.length} archive-requested events`;
    },
  });

  // Archive a single machine via the provider SDK (e.g. Daytona)
  cc.registerConsumer({
    name: "archiveMachineViaProvider",
    on: "machine:archive-requested",
    async handler(params) {
      const { machineId, type, externalId, metadata } = params.payload;
      const db = getDb();

      const runtime = await createMachineStub({
        type,
        env,
        externalId,
        metadata,
      });
      await runtime.archive();

      await db
        .update(schema.machine)
        .set({ state: "archived" })
        .where(eq(schema.machine.id, machineId));

      logger.info("[archiveMachineViaProvider] Archived machine", { machineId });
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
