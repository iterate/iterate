import { eq, and, inArray, sql } from "drizzle-orm";
import { createMachineStub } from "@iterate-com/sandbox/providers/machine-stub";
import { match } from "schematch";
import { z } from "zod/v4";
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
import { createDaemonClient } from "../utils/daemon-orpc-client.ts";
import { outboxClient as cc } from "./client.ts";

const IterateMainPushWebhookPayload = z.object({
  event: z.literal("push"),
  payload: z.object({
    ref: z.string(),
    repository: z.object({
      full_name: z.literal("iterate/iterate"),
    }),
  }),
});

function parseGitRefBranch(ref: string): string | null {
  const prefix = "refs/heads/";
  if (!ref.startsWith(prefix)) return null;
  return ref.slice(prefix.length);
}

export const registerConsumers = () => {
  registerTestConsumers();

  // ── Provisioning pipeline ──────────────────────────────────────────────
  //
  // machine:created → provisionMachine
  // (daemon reports status via reportStatus → machine:daemon-status-reported → setup + probe pipeline)

  // ── Slack webhook forwarding ─────────────────────────────────────────
  //
  // slack:webhook-received → forwardSlackWebhook

  cc.registerConsumer({
    name: "forwardSlackWebhook",
    on: "slack:webhook-received",
    when: (params) => !!params.payload.machineId,
    async handler(params) {
      const { machineId, payload, correlation } = params.payload;
      if (!machineId) throw new Error(`Machine id expected`);

      const db = await getDb();
      const machine = await db.query.machine.findFirst({
        where: eq(schema.machine.id, machineId),
      });
      if (!machine) return `skipped: machine ${machineId} not found`;
      if (machine.state !== "active")
        return `skipped: machine ${machineId} state is ${machine.state}`;

      const { forwardSlackWebhookToMachine } = await import("../integrations/slack/slack.ts");
      const result = await forwardSlackWebhookToMachine(machine, payload, env, correlation);
      if (!result.success) {
        throw new Error(`Slack forward failed: ${result.error}`);
      }

      logger.set({ machine: { id: machineId } });
      logger.info("[forwardSlackWebhook] Forwarded to machine");
      return `forwarded to ${machineId}`;
    },
  });

  cc.registerConsumer({
    name: "requestIterateMachinePulls",
    on: "github:webhook-received",
    async handler(params) {
      const db = await getDb();

      return match(params.payload)
        .case(IterateMainPushWebhookPayload, async (payload) => {
          const branch = parseGitRefBranch(payload.payload.ref);
          if (branch !== "main") {
            return `skipped: ref ${payload.payload.ref}`;
          }

          const result = await cc.sendCTE({
            query: db
              .select({ id: schema.machine.id })
              .from(schema.machine)
              .where(eq(schema.machine.state, "active")),
            name: "machine:pull-iterate-iterate-requested",
            payload: (result) => ({
              machineId: result.id,
              ref: branch,
            }),
          });

          logger.set({ eventId: params.eventId, targetCount: result.length });
          logger.info("[GitHub Webhook] Enqueued iterate machine pulls");
          return `enqueued ${result.length} iterate machine pull requests`;
        })
        .default(() => `skipped: unsupported github webhook ${params.payload.event}`);
    },
  });

  cc.registerConsumer({
    name: "triggerMachinePullIterateIterate",
    on: "machine:pull-iterate-iterate-requested",
    async handler(params) {
      const db = await getDb();
      const machine = await db.query.machine.findFirst({
        where: eq(schema.machine.id, params.payload.machineId),
      });

      if (!machine) {
        logger.set({
          machineId: params.payload.machineId,
          eventId: params.eventId,
        });
        logger.warn("[GitHub Webhook] Skipping iterate pull for missing machine");
        return `skipped: machine ${params.payload.machineId} not found`;
      }

      if (machine.state !== "active") {
        logger.set({
          machineId: machine.id,
          state: machine.state,
          eventId: params.eventId,
        });
        logger.info("[GitHub Webhook] Skipping iterate pull for non-active machine");
        return `skipped: machine ${machine.id} state is ${machine.state}`;
      }

      const runtime = await createMachineStub({
        type: machine.type,
        env,
        externalId: machine.externalId,
        metadata: (machine.metadata as Record<string, unknown>) ?? {},
      });
      const fetcher = await runtime.getFetcher(3000);
      const baseUrl = await runtime.getBaseUrl(3000);
      const daemonClient = createDaemonClient({ baseUrl, fetcher });
      await daemonClient.daemon.pullIterateIterate({ ref: params.payload.ref });

      logger.set({
        machineId: machine.id,
        ref: params.payload.ref,
        eventId: params.eventId,
      });
      logger.info("[GitHub Webhook] Triggered iterate pull on machine");
      return `triggered iterate pull on ${machine.id}`;
    },
  });

  cc.registerConsumer({
    name: "provisionMachine",
    on: "machine:created",
    visibilityTimeout: "300s", // provisioning can take minutes (Daytona snapshot, etc.)
    retry: (job) => {
      if (job.read_ct <= 2) return { retry: true, reason: "retrying provisioning", delay: "10s" };
      return { retry: false, reason: "provisioning failed after retries" };
    },
    async handler(params) {
      const { machineId } = params.payload;
      const db = await getDb();

      const machine = await db.query.machine.findFirst({
        where: eq(schema.machine.id, machineId),
        with: { project: { with: { organization: true } } },
      });
      if (!machine) throw new Error(`Machine ${machineId} not found`);

      if (machine.state !== "starting") {
        logger.set({ machine: { id: machineId } });
        logger.info(
          `[provisionMachine] Skipping, machine no longer starting state=${machine.state}`,
        );
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
        customDomain: machine.project.customDomain,
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

      logger.set({ machine: { id: machineId } });
      logger.info(`[provisionMachine] Machine provisioned type=${machine.type}`);
      return `provisioned machine ${machineId}`;
    },
  });

  // ── Setup + readiness probe pipeline ────────────────────────────────
  //
  // daemon-status-reported → pushMachineSetup → (setup-pushed)
  //   → sendReadinessProbe → (probe-sent) → pollProbeResponse
  //     → (probe-succeeded) → activateMachine → (activated)
  //     (probe failure handled by outbox retry → status="failed" in queue)

  // Stage 0: Daemon reported ready — push env vars and clone repos.
  cc.registerConsumer({
    name: "pushMachineSetup",
    on: "machine:daemon-status-reported",
    when: (params) => params.payload.status === "ready" && !!params.payload.externalId,
    visibilityTimeout: "120s", // env write + repo clones can take a while
    retry: (job) => {
      if (job.read_ct <= 2) return { retry: true, reason: "retrying setup push", delay: "10s" };
      return { retry: false, reason: "setup push failed after retries" };
    },
    async handler(params) {
      const { machineId, projectId } = params.payload;
      logger.set({ machine: { id: machineId } });
      const db = await getDb();

      const machine = await db.query.machine.findFirst({
        where: eq(schema.machine.id, machineId),
      });
      if (!machine) throw new Error(`Machine ${machineId} not found`);

      const { getPushMachineSetupInput, pushSetupToMachine } =
        await import("../services/machine-setup.ts");

      const input = await getPushMachineSetupInput(db, env, machine);
      if (!input) {
        logger.info("[pushMachineSetup] Sentinel matches, skipping setup + probe");
        return `skipped: setup already done for ${machineId}`;
      }

      const writeSentinel = await pushSetupToMachine(machine, input);

      // Emit setup-pushed so the readiness probe can begin
      await cc.send(db, {
        name: "machine:setup-pushed",
        payload: { machineId, projectId },
      });

      await writeSentinel();

      logger.info("[pushMachineSetup] Setup pushed to machine");
      return `setup pushed to ${machineId}`;
    },
  });

  // Stage 1: Setup pushed — wait for services to restart, then send readiness probe.
  cc.registerConsumer({
    name: "sendReadinessProbe",
    on: "machine:setup-pushed",
    visibilityTimeout: "45s", // send retries up to 30s + margin
    delay: () => "5s", // brief pause for env vars to take effect
    retry: (job) => {
      if (job.read_ct <= 2) return { retry: true, reason: "retrying probe send", delay: "5s" };
      return { retry: false, reason: "probe send failed after retries" };
    },
    async handler(params) {
      const { machineId, projectId } = params.payload;
      const db = await getDb();

      const machine = await db.query.machine.findFirst({
        where: eq(schema.machine.id, machineId),
      });
      if (!machine) throw new Error(`Machine ${machineId} not found`);

      if (machine.state !== "starting") {
        logger.set({ machine: { id: machineId } });
        logger.info(
          `[sendReadinessProbe] Skipping, machine no longer starting state=${machine.state}`,
        );
        return `skipped: machine state is ${machine.state}`;
      }

      const fetcher = await buildMachineFetcher(machine, env);
      if (!fetcher) {
        throw new Error(`Could not build fetcher for machine ${machineId}`);
      }

      const sendResult = await sendProbeMessage(fetcher, {
        machineId,
        probeId: params.job.id,
      });
      if (!sendResult.ok) {
        throw new Error(`probe send failed: ${sendResult.detail}`);
      }

      // Probe message sent successfully — emit probe-sent so polling begins
      await cc.send(db, {
        name: "machine:probe-sent",
        payload: {
          machineId,
          projectId,
          threadId: sendResult.threadId,
          messageId: sendResult.messageId,
        },
      });

      logger.set({ machine: { id: machineId }, threadId: sendResult.threadId });
      logger.info(`[sendReadinessProbe] Probe message sent messageId=${sendResult.messageId}`);
      return `probe sent, messageId=${sendResult.messageId}`;
    },
  });

  // Stage 2: Probe message was sent — poll for a valid response.
  cc.registerConsumer({
    name: "pollProbeResponse",
    on: "machine:probe-sent",
    visibilityTimeout: "75s", // poll runs up to 60s + margin
    retry: (job) => {
      // Polling runs up to 60s internally, or fails immediately on wrong answer.
      // Outbox retry covers worker-level failures (e.g. worker restarted mid-poll).
      if (job.read_ct <= 1) return { retry: true, reason: "retrying poll", delay: "5s" };
      return { retry: false, reason: "poll failed after retry" };
    },
    async handler(params) {
      const { machineId, projectId, threadId } = params.payload;
      const db = await getDb();

      const machine = await db.query.machine.findFirst({
        where: eq(schema.machine.id, machineId),
      });
      if (!machine) throw new Error(`Machine ${machineId} not found`);

      if (machine.state !== "starting") {
        logger.set({ machine: { id: machineId } });
        logger.info(
          `[pollProbeResponse] Skipping, machine no longer starting state=${machine.state}`,
        );
        return `skipped: machine state is ${machine.state}`;
      }

      const fetcher = await buildMachineFetcher(machine, env);
      if (!fetcher) {
        throw new Error(`Could not build fetcher for machine ${machineId}`);
      }

      const responseText = await pollForProbeAnswer(fetcher, threadId);

      await cc.send(db, {
        name: "machine:probe-succeeded",
        payload: {
          machineId,
          projectId,
          responseText,
        },
      });

      logger.set({ machine: { id: machineId } });
      logger.info(`[pollProbeResponse] Probe succeeded responseText=${responseText}`);
      return `probe succeeded: "${responseText}"`;
    },
  });

  // Stage 3a: Probe succeeded — activate the machine.
  cc.registerConsumer({
    name: "activateMachine",
    on: "machine:probe-succeeded",
    async handler(params) {
      const { machineId, projectId } = params.payload;
      const db = await getDb();

      const machine = await db.query.machine.findFirst({
        where: eq(schema.machine.id, machineId),
      });
      if (!machine) throw new Error(`Machine ${machineId} not found`);

      if (machine.state !== "starting") {
        logger.set({ machine: { id: machineId } });
        logger.info(
          `[activateMachine] Skipping, machine no longer starting state=${machine.state}`,
        );
        return `skipped: machine state is ${machine.state}`;
      }

      const activated = await db.transaction(async (tx) => {
        // Re-check state inside the transaction (TOCTOU protection)
        const current = await tx.query.machine.findFirst({
          where: eq(schema.machine.id, machineId),
        });
        if (current?.state !== "starting") {
          logger.set({ machine: { id: machineId } });
          logger.info(
            `[activateMachine] Skipping inside tx, state changed state=${current?.state}`,
          );
          return false;
        }

        // Bulk-detach all active machines for this project
        const detached = await tx
          .update(schema.machine)
          .set({ state: "detached" })
          .where(and(eq(schema.machine.projectId, projectId), eq(schema.machine.state, "active")))
          .returning({ id: schema.machine.id });

        // Promote this machine to active
        await tx
          .update(schema.machine)
          .set({ state: "active" })
          .where(eq(schema.machine.id, machineId));

        // Emit activated event inside the transaction for atomicity
        await cc.send(tx, {
          name: "machine:activated",
          payload: {
            machineId,
            projectId,
            detachedMachineIds: detached.map((m) => m.id),
          },
        });

        return true;
      });

      logger.set({ machine: { id: machineId } });
      logger.info(`[activateMachine] Machine activated:${activated}`);
      return `machine activated:${activated}`;
    },
  });

  // ── Post-activation pipeline ──────────────────────────────────────────

  // When a machine is activated, find detached machines and fan out delete events
  cc.registerConsumer({
    name: "deleteDetachedMachines",
    on: "machine:activated",
    delay: () => "4h",
    async handler(params) {
      const { projectId, machineId, detachedMachineIds } = params.payload;
      const db = await getDb();

      if (detachedMachineIds.length === 0) {
        return "no detached machines to delete";
      }

      const result = await cc.sendCTE({
        query: db
          .select({
            id: schema.machine.id,
            type: schema.machine.type,
            externalId: schema.machine.externalId,
            metadata: sql<
              Record<string, unknown>
            >`coalesce(${schema.machine.metadata}, '{}'::jsonb)`,
          })
          .from(schema.machine)
          .where(inArray(schema.machine.id, detachedMachineIds)),
        name: "machine:delete-requested",
        payload: (result) => ({
          machineId: result.id,
          type: result.type,
          externalId: result.externalId,
          metadata: result.metadata,
        }),
      });

      logger.set({ machine: { id: machineId }, project: { id: projectId } });
      logger.info(`[deleteDetachedMachines] Fan-out delete enqueuedCount=${result.length}`);
      return `enqueued ${result.length} delete-requested events`;
    },
  });

  // Delete a single machine via the provider SDK
  cc.registerConsumer({
    name: "deleteMachineViaProvider",
    on: "machine:delete-requested",
    async handler(params) {
      const { machineId, type, externalId, metadata } = params.payload;
      const db = await getDb();

      const runtime = await createMachineStub({
        type,
        env,
        externalId,
        metadata,
      });
      await runtime.delete();

      await db
        .update(schema.machine)
        .set({ state: "archived" })
        .where(eq(schema.machine.id, machineId));

      logger.set({ machine: { id: machineId } });
      logger.info("[deleteMachineViaProvider] Deleted machine");
      return `deleted machine ${machineId}`;
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
    on: "rpc:admin.outbox.poke",
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
    on: "rpc:admin.outbox.poke",
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
    on: "rpc:admin.outbox.poke",
    retry: (job) => {
      if (job.read_ct <= 5) return { retry: true, reason: "always retry", delay: "1s" };
      return { retry: false, reason: "max retries reached" };
    },
    when: (params) => params.payload.input.message.includes("fail"),
    handler: (params) => {
      throw new Error(`[test_error] Attempt ${params.job.attempt} failed ${Math.random()}`);
    },
  });
}
