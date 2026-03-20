import { eq, and, inArray, sql } from "drizzle-orm";
import { createMachineStub } from "@iterate-com/sandbox/providers/machine-stub";
import { match } from "schematch";
import { z } from "zod/v4";
import { ORPCError } from "@orpc/client";
import { getDb } from "../db/client.ts";
import * as schema from "../db/schema.ts";
import {
  PosthogWebhookReceivedEventPayload,
  ResendWebhookReceivedEventPayload,
} from "../events.ts";
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

function parseSenderEmail(from: string): string {
  const match = from.match(/<([^>]+)>/);
  return match ? match[1] : from;
}

function parseRecipientLocal(to: string): string {
  const email = to.includes("<") ? parseSenderEmail(to) : to;
  return email.split("@")[0];
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
      return `forwarded to ${machineId}`;
    },
  });

  cc.registerConsumer({
    name: "forwardResendWebhook",
    on: "resend:webhook-received",
    async handler(params) {
      const payload = ResendWebhookReceivedEventPayload.parse(params.payload);
      const resendEmailId = payload.data.email_id;
      const senderEmail = parseSenderEmail(payload.data.from).toLowerCase();
      const db = await getDb();

      const user = await db.query.user.findFirst({
        where: (u, { eq: whereEq }) => whereEq(u.email, senderEmail),
      });
      if (!user) {
        logger.warn(`No user found for sender ${senderEmail}`);
        return `skipped: no user found for ${senderEmail}`;
      }

      const memberships = await db.query.organizationUserMembership.findMany({
        where: (m, { eq: whereEq }) => whereEq(m.userId, user.id),
        with: {
          organization: {
            with: {
              projects: {
                with: {
                  machines: {
                    where: (m, { eq: whereEq }) => whereEq(m.state, "active"),
                    limit: 1,
                  },
                },
              },
            },
          },
        },
      });
      if (memberships.length === 0) {
        logger.set({ user: { id: user.id } });
        logger.warn("No org memberships for user");
        return `skipped: user ${user.id} has no org memberships`;
      }

      const recipientLocal = payload.data.to[0] ? parseRecipientLocal(payload.data.to[0]) : "";
      const projectSlugMatch = recipientLocal.match(/\+([^@]+)$/);
      const targetProjectSlug = projectSlugMatch ? projectSlugMatch[1] : null;

      let targetProject:
        | (typeof schema.project.$inferSelect & {
            machines: (typeof schema.machine.$inferSelect)[];
          })
        | null = null;

      for (const membership of memberships) {
        const org = membership.organization;
        for (const project of org.projects) {
          if (targetProjectSlug && project.slug === targetProjectSlug) {
            targetProject = project;
            break;
          }
          if (!targetProjectSlug && project.machines.length > 0 && !targetProject) {
            targetProject = project;
          }
        }
        if (targetProject) break;
      }

      if (!targetProject) {
        logger.set({ user: { id: user.id } });
        logger.warn(`No project found for email targetProjectSlug=${targetProjectSlug ?? "none"}`);
        return `skipped: no project found for ${targetProjectSlug ?? "default route"}`;
      }

      const targetMachine = targetProject.machines[0];
      if (!targetMachine) {
        logger.set({ project: { id: targetProject.id }, user: { id: user.id } });
        return `skipped: project ${targetProject.id} has no active machine`;
      }

      const { createResendClient, fetchEmailContent, forwardEmailWebhookToMachine } =
        await import("../integrations/resend/resend.ts");
      const resendClient = createResendClient(env.RESEND_BOT_API_KEY);
      const emailContent = await fetchEmailContent(resendClient, resendEmailId);

      logger.debug("Forwarding to machine", { machineId: targetMachine.id });
      const forwardResult = await forwardEmailWebhookToMachine(
        targetMachine,
        {
          ...payload,
          _iterate: {
            userId: user.id,
            projectId: targetProject.id,
            emailBody: emailContent
              ? {
                  text: emailContent.text,
                  html: emailContent.html,
                }
              : null,
          },
        },
        env,
      );
      if (!forwardResult.success) {
        throw new Error(`Resend forward failed: ${forwardResult.error}`);
      }

      logger.set({ machine: { id: targetMachine.id }, user: { id: user.id } });
      return `forwarded to ${targetMachine.id}`;
    },
  });

  cc.registerConsumer({
    name: "forwardPosthogWebhook",
    on: "posthog:webhook-received",
    async handler(params) {
      const { deliveryId, payload } = PosthogWebhookReceivedEventPayload.parse(params.payload);
      const db = await getDb();
      const connection = await db.query.projectConnection.findFirst({
        where: (pc, { and, eq: whereEq }) =>
          and(whereEq(pc.provider, "slack"), whereEq(pc.externalId, "T0675PSN873")),
        with: {
          project: {
            with: {
              machines: {
                where: (m, { eq: whereEq }) => whereEq(m.state, "active"),
                limit: 1,
              },
            },
          },
        },
      });

      const projectId = connection?.projectId ?? null;
      const machine = connection?.project?.machines[0] ?? null;
      if (!machine) {
        logger.set({ deliveryId, projectId });
        logger.warn("No active machine for Iterate Slack team");
        return "skipped: no active machine for Iterate Slack team";
      }

      const { forwardPosthogWebhookToMachine } = await import("../integrations/posthog/proxy.ts");
      try {
        await forwardPosthogWebhookToMachine({
          machine,
          env,
          deliveryId,
          payload,
        });
      } catch (error) {
        logger.set({ deliveryId, machineId: machine.id, projectId });
        throw new Error(
          `Failed to forward to machine: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      logger.set({ deliveryId, machineId: machine.id, projectId });
      return `forwarded to ${machine.id}`;
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
        logger.warn("Skipping iterate pull for missing machine");
        return `skipped: machine ${params.payload.machineId} not found`;
      }

      if (machine.state !== "active") {
        logger.set({
          machineId: machine.id,
          state: machine.state,
          eventId: params.eventId,
        });
        return `skipped: machine ${machine.id} state is ${machine.state}`;
      }

      try {
        const runtime = await createMachineStub({
          type: machine.type,
          env,
          externalId: machine.externalId,
          metadata: (machine.metadata as Record<string, unknown>) ?? {},
        });
        const fetcher = await runtime.getFetcher(3000);
        const baseUrl = await runtime.getBaseUrl(3000);
        const daemonClient = createDaemonClient({ baseUrl, fetcher });
        await daemonClient.daemon.pullIterateIterate({
          ref: params.payload.ref,
        });
      } catch (e: unknown) {
        if (e instanceof Error && e.name === "DaytonaNotFoundError") {
          logger.set({
            machineId: machine.id,
            externalId: machine.externalId,
            eventId: params.eventId,
          });
          logger.warn("Skipping iterate pull for deleted sandbox");
          return `skipped: sandbox for machine ${machine.id} not found in Daytona (${machine.externalId})`;
        }

        // The daemon may be mid-restart (from a prior pull) or the sandbox
        // proxy may return a non-oRPC response (HTML error page, unusual
        // status code).  The oRPC client surfaces this as an ORPCError with
        // a code derived from the HTTP status — "BAD_GATEWAY" (502),
        // "SERVICE_UNAVAILABLE" (503), "GATEWAY_TIMEOUT" (504), or the
        // catch-all "MALFORMED_ORPC_ERROR_RESPONSE".  Retrying indefinitely
        // is wasteful — the next push to main will fan-out a fresh attempt.
        const TRANSIENT_ORPC_CODES: string[] = [
          "BAD_GATEWAY",
          "SERVICE_UNAVAILABLE",
          "GATEWAY_TIMEOUT",
          "MALFORMED_ORPC_ERROR_RESPONSE",
        ];
        if (e instanceof ORPCError && TRANSIENT_ORPC_CODES.includes(e.code)) {
          logger.set({
            machineId: machine.id,
            orpcCode: e.code,
            orpcStatus: e.status,
            eventId: params.eventId,
          });
          logger.warn("Skipping iterate pull: daemon returned non-oRPC error response");
          return `skipped: machine ${machine.id} daemon returned malformed oRPC response (code ${e.code}, status ${e.status})`;
        }

        throw e;
      }

      logger.set({
        machineId: machine.id,
        ref: params.payload.ref,
        eventId: params.eventId,
      });
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

      logger.set({ machine: { id: machineId }, machineType: machine.type });
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
        return `skipped: setup already done for ${machineId}`;
      }

      const writeSentinel = await pushSetupToMachine(machine, input);

      // Emit setup-pushed so the readiness probe can begin
      await cc.send(db, {
        name: "machine:setup-pushed",
        payload: { machineId, projectId },
      });

      await writeSentinel();

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

      logger.set({
        machine: { id: machineId },
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

      logger.set({ machine: { id: machineId }, responseText });
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
        return `skipped: machine state is ${machine.state}`;
      }

      const activated = await db.transaction(async (tx) => {
        // Re-check state inside the transaction (TOCTOU protection)
        const current = await tx.query.machine.findFirst({
          where: eq(schema.machine.id, machineId),
        });
        if (current?.state !== "starting") {
          logger.set({ machine: { id: machineId } });
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

      logger.set({ machine: { id: machineId }, activated });
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

      logger.set({
        machine: { id: machineId },
        project: { id: projectId },
        enqueuedCount: result.length,
      });
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
      return "received message: " + params.payload.message;
    },
  });

  cc.registerConsumer({
    name: "logGreeting",
    on: "rpc:admin.outbox.poke",
    when: (params) => params.payload.input.message.includes("hi"),
    handler: () => {
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
