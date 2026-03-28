import { eq, and, inArray, isNull, sql } from "drizzle-orm";
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
import { buildMachineEnvVars, createMachineForProject } from "../services/machine-creation.ts";
import { createUserFromVerifiedEmail } from "../auth/auth.ts";
import { stripMachineStateMetadata } from "../utils/machine-metadata.ts";
import { createDaemonClient } from "../utils/daemon-orpc-client.ts";
import { isSignupAllowed } from "../email/signup-allowlist.ts";
import { getDefaultOrganizationNameFromEmail, parseSender } from "../email/email-routing.ts";
import { parseSpecMachineEmail } from "../email/spec-machine.ts";
import { slugifyWithSuffix } from "../utils/slug.ts";
import { getDefaultProjectSandboxProvider } from "../utils/sandbox-providers.ts";
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

function createDefaultMachineName(sandboxProvider: string): string {
  const date = new Date();
  const month = date.toLocaleString("en-US", { month: "short" }).toLowerCase();
  const day = date.getDate();
  const hour = date.getHours().toString().padStart(2, "0");
  const minute = date.getMinutes().toString().padStart(2, "0");
  return `${sandboxProvider}-${month}-${day}-${hour}h${minute}`;
}

function isMissingSandboxError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;

  if (error.name === "DaytonaNotFoundError") return true;

  return [
    /No such container/i,
    /not found in Daytona/i,
    /failed \(404\)/i,
    /machine .* not found/i,
    /app .* not found/i,
  ].some((pattern) => pattern.test(error.message));
}

async function findAvailableProjectSlug(db: Awaited<ReturnType<typeof getDb>>, baseSlug: string) {
  let candidate = baseSlug;

  while (true) {
    const [existingOrg, existingProject] = await Promise.all([
      db.query.organization.findFirst({ where: eq(schema.organization.slug, candidate) }),
      db.query.project.findFirst({ where: eq(schema.project.slug, candidate) }),
    ]);

    if (!existingOrg && !existingProject) return candidate;
    candidate = slugifyWithSuffix(baseSlug);
  }
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
    name: "routeResendWebhook",
    on: "resend:webhook-received",
    async handler(params) {
      const payload = ResendWebhookReceivedEventPayload.parse(params.payload);
      const resendEmailId = payload.data.email_id;
      const db = await getDb();
      const senderEmail = parseSender(payload.data.from).email;
      const [routing] = await db
        .select({
          user: schema.user,
          project: schema.project,
          machine: schema.machine,
        })
        .from(schema.user)
        .leftJoin(
          schema.organizationUserMembership,
          eq(schema.organizationUserMembership.userId, schema.user.id),
        )
        .leftJoin(
          schema.organization,
          eq(schema.organization.id, schema.organizationUserMembership.organizationId),
        )
        .leftJoin(schema.project, eq(schema.project.organizationId, schema.organization.id))
        .leftJoin(
          schema.machine,
          and(
            eq(schema.machine.projectId, schema.project.id),
            inArray(schema.machine.state, ["active", "starting"]),
          ),
        )
        .where(eq(schema.user.email, senderEmail))
        .orderBy(
          sql`
            case
              when ${schema.machine.state} = 'active' then 0
              when ${schema.machine.state} = 'starting' then 1
              when ${schema.project.id} is not null then 2
              else 3
            end
          `,
          schema.project.createdAt,
        )
        .limit(1);

      logger.set({
        emailRouting: {
          project: routing?.project?.slug,
          projectId: routing?.project?.id,
          machine: routing?.machine?.state,
          machineId: routing?.machine?.id,
          machineExternalId: routing?.machine?.externalId,
          userId: routing?.user?.id,
        },
      });

      if (routing?.machine?.state === "active") {
        // happy path: machine is already active
        const { createResendClient, fetchEmailContent, forwardEmailWebhookToMachine } =
          await import("../integrations/resend/resend.ts");
        const resendClient = createResendClient(env.RESEND_BOT_API_KEY);
        const emailContent =
          payload._iterate_email_content || (await fetchEmailContent(resendClient, resendEmailId));

        const forwardResult = await forwardEmailWebhookToMachine(
          routing.machine,
          {
            ...payload,
            _iterate: {
              userId: routing.user.id,
              projectId: routing.machine.projectId,
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

        await db
          .update(schema.emailInboundDelivery)
          .set({ status: "forwarded" })
          .where(eq(schema.emailInboundDelivery.externalId, resendEmailId));

        return `forwarded to ${routing.machine.id}`;
      }

      if (!routing?.user && !isSignupAllowed(senderEmail, env.SIGNUP_ALLOWLIST)) {
        logger.warn(`sender ${senderEmail} is not allowlisted for email onboarding`);
        return `skipped: sender ${senderEmail} is not allowlisted`;
      }

      await db
        .insert(schema.emailInboundDelivery)
        .values({
          provider: "resend",
          externalId: resendEmailId,
          senderEmail,
          outboxEventId: params.eventId,
          projectId: routing?.project?.id ?? null,
          status: "pending",
        })
        .onConflictDoUpdate({
          target: [schema.emailInboundDelivery.provider, schema.emailInboundDelivery.externalId],
          set: {
            outboxEventId: params.eventId,
            senderEmail,
            projectId: routing?.project?.id ?? sql`${schema.emailInboundDelivery.projectId}`,
            status: "pending",
            updatedAt: new Date(),
          },
        });

      if (!routing?.user) {
        await cc.send(db, {
          name: "email:onboarding-requested",
          payload: {
            provider: "resend",
            externalEmailId: resendEmailId,
          },
          deduplicationKey: senderEmail,
        });

        return `enqueued onboarding for ${senderEmail}`;
      }

      return `waiting for active machine`;
    },
  });

  cc.registerConsumer({
    name: "onboardEmailSender",
    on: "email:onboarding-requested",
    async handler(params) {
      const db = await getDb();
      const delivery = await db.query.emailInboundDelivery.findFirst({
        where: eq(schema.emailInboundDelivery.externalId, params.payload.externalEmailId),
      });
      if (!delivery) {
        throw new Error(`missing inbound delivery for ${params.payload.externalEmailId}`);
      }

      const event = await db.query.outboxEvent.findFirst({
        where: eq(schema.outboxEvent.id, delivery.outboxEventId),
      });
      if (!event) {
        throw new Error(`missing outbox event ${delivery.outboxEventId}`);
      }

      const payload = ResendWebhookReceivedEventPayload.parse(event.payload);
      const sender = parseSender(payload.data.from);
      const specMachine = parseSpecMachineEmail(sender.email);
      const user = await createUserFromVerifiedEmail({
        db,
        env,
        email: sender.email,
        name: sender.name,
        consideredVerifiedReason:
          "Received email from this account, so we know they have access to it!",
      });

      const projectSlug = await findAvailableProjectSlug(
        db,
        getDefaultOrganizationNameFromEmail(sender.email),
      );

      const projectId = await db.transaction(async (tx) => {
        const [organization] = await tx
          .insert(schema.organization)
          .values({ name: projectSlug, slug: projectSlug })
          .returning();
        if (!organization) {
          throw new Error(`failed to create organization for ${sender.email}`);
        }

        await tx.insert(schema.organizationUserMembership).values({
          organizationId: organization.id,
          userId: user.id,
          role: "owner",
        });

        const [project] = await tx
          .insert(schema.project)
          .values({
            name: projectSlug,
            slug: projectSlug,
            organizationId: organization.id,
            sandboxProvider: specMachine
              ? "spec-machine"
              : getDefaultProjectSandboxProvider(env, import.meta.env.DEV),
          })
          .returning();
        if (!project) {
          throw new Error(`failed to create project for ${sender.email}`);
        }

        return project.id;
      });

      await db
        .update(schema.emailInboundDelivery)
        .set({ projectId })
        .where(
          and(
            eq(schema.emailInboundDelivery.senderEmail, sender.email),
            isNull(schema.emailInboundDelivery.projectId),
            eq(schema.emailInboundDelivery.status, "pending"),
          ),
        );

      await createMachineForProject({
        db,
        env,
        projectId,
        name: createDefaultMachineName(
          specMachine ? "spec-machine" : getDefaultProjectSandboxProvider(env, import.meta.env.DEV),
        ),
        metadata: { emailSender: sender.email },
      });

      logger.set({
        project: { id: projectId },
        user: { id: user.id },
      });
      return `onboarded ${params.payload.externalEmailId}`;
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
        if (isMissingSandboxError(e)) {
          logger.set({
            machineId: machine.id,
            externalId: machine.externalId,
            eventId: params.eventId,
          });
          logger.warn("Skipping iterate pull for missing sandbox");
          return `skipped: sandbox for machine ${machine.id} no longer exists (${machine.externalId})`;
        }

        // The daemon may be mid-restart (from a prior pull) or the sandbox
        // proxy may return a non-oRPC response (HTML error page, 502, etc.).
        // The oRPC client surfaces these as ORPCError with codes like
        // BAD_GATEWAY, MALFORMED_ORPC_ERROR_RESPONSE, or INTERNAL_SERVER_ERROR.
        // Retrying is wasteful — the next push to main will fan-out a fresh
        // attempt.
        if (e instanceof ORPCError) {
          logger.set({
            machineId: machine.id,
            orpcCode: e.code,
            orpcStatus: e.status,
            eventId: params.eventId,
          });
          logger.warn("Skipping iterate pull: daemon returned oRPC error");
          return `skipped: machine ${machine.id} daemon oRPC error ${e.code} (status ${e.status})`;
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
      if (job.read_ct <= 4) return { retry: true, reason: "retrying setup push", delay: "15s" };
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

      let input;
      try {
        input = await getPushMachineSetupInput(db, env, machine);
      } catch (e: unknown) {
        // The daemon may still be starting up when the outbox fires
        // immediately after daemon-status-reported.  The sandbox proxy
        // or half-ready daemon can return a non-oRPC 500 which the
        // client surfaces as MALFORMED_ORPC_ERROR_RESPONSE, or a
        // well-formed oRPC INTERNAL_SERVER_ERROR.  Log and re-throw
        // so the retry policy can handle it.
        if (e instanceof ORPCError) {
          logger.set({
            machineId: machine.id,
            orpcCode: e.code,
            orpcStatus: e.status,
            eventId: params.eventId,
          });
          logger.warn("pushMachineSetup: daemon oRPC call failed, will retry");
        }
        throw e;
      }
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

  cc.registerConsumer({
    name: "enqueueReadyEmailForwards",
    on: "machine:activated",
    async handler(params) {
      const db = await getDb();
      const deliveries = await db.query.emailInboundDelivery.findMany({
        where: and(
          eq(schema.emailInboundDelivery.projectId, params.payload.projectId),
          eq(schema.emailInboundDelivery.status, "pending"),
        ),
        with: { outboxEvent: true },
      });

      for (const delivery of deliveries) {
        // todo: better sendBatch support. Could also improve sendCTE to make it work better with select+join results
        await cc.send(db, {
          name: "resend:webhook-received",
          payload: ResendWebhookReceivedEventPayload.parse(delivery.outboxEvent.payload),
          deduplicationKey: `${delivery.externalId}:machine:activated:${params.eventId}`,
        });
      }

      return `enqueued ${deliveries.length} email forwards`;
    },
  });

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

  cc.registerConsumer({
    name: "testingSuccessConsumer",
    on: "rpc:testing.emitSuccessfulOutboxEvent",
    handler: (params) => {
      return `testing success: ${String(params.payload.input.message)}`;
    },
  });

  cc.registerConsumer({
    name: "testingFailingConsumer",
    on: "rpc:testing.emitFailingOutboxEvent",
    handler: (params) => {
      throw new Error(`[test_outbox_consumer_error] ${String(params.payload.input.message)}`);
    },
  });
}
