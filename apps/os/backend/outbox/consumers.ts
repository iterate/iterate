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
import { outboxClient as cc } from "./client.ts";

export const registerConsumers = () => {
  registerTestConsumers();

  // ── Provisioning pipeline ──────────────────────────────────────────────
  //
  // machine:created → provisionMachine
  // (daemon reports status via reportStatus → machine:daemon-status-reported → setup + probe pipeline)

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
      const db = getDb();

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
      const db = getDb();

      const machine = await db.query.machine.findFirst({
        where: eq(schema.machine.id, machineId),
      });
      if (!machine) throw new Error(`Machine ${machineId} not found`);

      if (machine.state !== "starting") {
        logger.set({ machine: { id: machineId } });
        logger.info(
          `[pushMachineSetup] Skipping, machine no longer starting state=${machine.state}`,
        );
        return `skipped: machine state is ${machine.state}`;
      }

      const { pushSetupToMachine } = await import("../services/machine-setup.ts");
      await pushSetupToMachine(db, env, machine);

      // Emit setup-pushed so the readiness probe can begin
      await cc.send({ transaction: db, parent: db }, "machine:setup-pushed", {
        machineId,
        projectId,
      });

      logger.set({ machine: { id: machineId } });
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
      const db = getDb();

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
      const db = getDb();

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

      await cc.send({ transaction: db, parent: db }, "machine:probe-succeeded", {
        machineId,
        projectId,
        responseText,
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
      const db = getDb();

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

        return true;
      });

      logger.set({ machine: { id: machineId } });
      logger.info(`[activateMachine] Machine activated:${activated}`);
      return `machine activated:${activated}`;
    },
  });

  // ── Email-bot auto-provisioning pipeline ────────────────────────────
  //
  // email:received-unknown-sender → createEmailBotUser → (email:user-created)
  //   → createEmailBotOrg → (email:org-created)
  //     → createEmailBotProject → (email:project-created)
  //       → provisionEmailBotInfra → machine:created (existing pipeline)
  //         → ... → machine:activated → forwardPendingEmail
  registerEmailBotConsumers();

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

      logger.set({ machine: { id: machineId }, project: { id: projectId } });
      logger.info(
        `[archiveStaleDetachedMachines] Fan-out archival enqueuedCount=${staleDetached.length}`,
      );
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

      logger.set({ machine: { id: machineId } });
      logger.info("[archiveMachineViaProvider] Archived machine");
      return `archived machine ${machineId}`;
    },
  });
};

// ── Email-bot auto-provisioning consumers ────────────────────────────

function registerEmailBotConsumers() {
  cc.registerConsumer({
    name: "createEmailBotUser",
    on: "email:received-unknown-sender",
    visibilityTimeout: "30s",
    retry: (job) => {
      if (job.read_ct <= 2) return { retry: true, reason: "retrying user creation", delay: "5s" };
      return { retry: false, reason: "user creation failed after retries" };
    },
    async handler(params) {
      const { senderEmail, senderName, resendEmailId, resendPayload, recipientEmail } =
        params.payload;
      const db = getDb();

      const { createEmailBotUser } = await import("../services/email-bot-provisioning.ts");
      const { userId } = await createEmailBotUser(db, env, { senderEmail, senderName });

      await cc.send({ transaction: db, parent: db }, "email:user-created", {
        userId,
        senderEmail,
        resendEmailId,
        resendPayload,
        recipientEmail,
      });

      logger.info(`[createEmailBotUser] Done userId=${userId} email=${senderEmail}`);
      return `user created: ${userId}`;
    },
  });

  cc.registerConsumer({
    name: "createEmailBotOrg",
    on: "email:user-created",
    visibilityTimeout: "30s",
    retry: (job) => {
      if (job.read_ct <= 2) return { retry: true, reason: "retrying org creation", delay: "5s" };
      return { retry: false, reason: "org creation failed after retries" };
    },
    async handler(params) {
      const { userId, senderEmail, resendEmailId, resendPayload, recipientEmail } = params.payload;
      const db = getDb();

      const { createEmailBotOrg } = await import("../services/email-bot-provisioning.ts");
      const { organizationId } = await createEmailBotOrg(db, { userId, senderEmail });

      await cc.send({ transaction: db, parent: db }, "email:org-created", {
        userId,
        organizationId,
        resendEmailId,
        resendPayload,
        recipientEmail,
      });

      logger.info(`[createEmailBotOrg] Done orgId=${organizationId}`);
      return `org created: ${organizationId}`;
    },
  });

  cc.registerConsumer({
    name: "createEmailBotProject",
    on: "email:org-created",
    visibilityTimeout: "30s",
    retry: (job) => {
      if (job.read_ct <= 2)
        return { retry: true, reason: "retrying project creation", delay: "5s" };
      return { retry: false, reason: "project creation failed after retries" };
    },
    async handler(params) {
      const { userId, organizationId, resendEmailId, resendPayload, recipientEmail } =
        params.payload;
      const db = getDb();

      const { createEmailBotProject } = await import("../services/email-bot-provisioning.ts");
      const { projectId } = await createEmailBotProject(db, env, { organizationId });

      await cc.send({ transaction: db, parent: db }, "email:project-created", {
        userId,
        organizationId,
        projectId,
        resendEmailId,
        resendPayload,
        recipientEmail,
      });

      logger.info(`[createEmailBotProject] Done projectId=${projectId}`);
      return `project created: ${projectId}`;
    },
  });

  cc.registerConsumer({
    name: "provisionEmailBotInfra",
    on: "email:project-created",
    visibilityTimeout: "300s", // Archil disk + machine creation can take a while
    retry: (job) => {
      if (job.read_ct <= 2)
        return { retry: true, reason: "retrying infra provisioning", delay: "15s" };
      return { retry: false, reason: "infra provisioning failed after retries" };
    },
    async handler(params) {
      const { userId, projectId, resendEmailId, resendPayload, recipientEmail } = params.payload;
      const db = getDb();

      const { provisionEmailBotInfra } = await import("../services/email-bot-provisioning.ts");
      const { machineId } = await provisionEmailBotInfra(db, env, {
        projectId,
        resendEmailId,
        resendPayload,
        recipientEmail,
        userId,
      });

      // The pending email forward is handled by the forwardPendingEmail consumer
      // which fires on machine:activated and checks for pendingEmail metadata.
      // We also emit email:pending-forward as a belt-and-suspenders approach
      // so the forward can be triggered even if metadata is lost.
      await cc.send({ transaction: db, parent: db }, "email:pending-forward", {
        projectId,
        machineId,
        resendEmailId,
        resendPayload,
        recipientEmail,
        userId,
      });

      logger.info(`[provisionEmailBotInfra] Done machineId=${machineId}`);
      return `infra provisioned: machine=${machineId}`;
    },
  });

  // Forward the original email once the machine is active.
  // This consumer is delayed — it polls for machine activation.
  cc.registerConsumer({
    name: "forwardPendingEmail",
    on: "email:pending-forward",
    visibilityTimeout: "600s", // machine provisioning can take several minutes
    delay: () => "30s", // give the machine time to provision + activate
    retry: (job) => {
      // Keep retrying for up to ~10 minutes (machine provisioning)
      if (job.read_ct <= 20) return { retry: true, reason: "waiting for machine", delay: "30s" };
      return { retry: false, reason: "machine did not activate in time" };
    },
    async handler(params) {
      const { projectId, resendEmailId, resendPayload, userId } = params.payload;
      const db = getDb();

      // Find active machine for the project
      const activeMachine = await db.query.machine.findFirst({
        where: (m, { eq: whereEq, and: whereAnd }) =>
          whereAnd(whereEq(m.projectId, projectId), whereEq(m.state, "active")),
      });

      if (!activeMachine) {
        // Machine not active yet — retry
        throw new Error(
          `[forwardPendingEmail] No active machine for project=${projectId}, will retry`,
        );
      }

      // Fetch full email content from Resend
      const { createResendClient, fetchEmailContent, forwardEmailWebhookToMachine } =
        await import("../integrations/resend/resend.ts");
      const resendClient = createResendClient(env.RESEND_BOT_API_KEY);
      const emailContent = await fetchEmailContent(resendClient, resendEmailId);

      const forwardPayload = {
        ...resendPayload,
        _iterate: {
          userId,
          projectId,
          emailBody: emailContent ? { text: emailContent.text, html: emailContent.html } : null,
        },
      };

      const result = await forwardEmailWebhookToMachine(activeMachine, forwardPayload, env);
      if (!result.success) {
        throw new Error(`[forwardPendingEmail] Forward failed error=${result.error}`);
      }

      logger.info(
        `[forwardPendingEmail] Email forwarded resendEmailId=${resendEmailId} machineId=${activeMachine.id}`,
      );
      return `email forwarded to machine ${activeMachine.id}`;
    },
  });
}

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
