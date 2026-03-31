import { z } from "zod/v4";
import { eq, sql } from "drizzle-orm";
import { ORPCError } from "@orpc/server";
import {
  publicProcedure,
  publicMutation,
  protectedProcedure,
  projectProtectedProcedure,
  ProjectInput,
} from "../procedures.ts";
import {
  user,
  organization,
  project,
  organizationUserMembership,
  projectConnection,
} from "../../db/schema.ts";
import { slugifyWithSuffix } from "../../utils/slug.ts";
import { getDefaultProjectSandboxProvider } from "../../utils/sandbox-providers.ts";
import { isNonProd, waitUntil } from "../../../env.ts";
import { queuer } from "../../outbox/outbox-queuer.ts";
import { logger } from "../../logging/index.ts";
import { toParsedLogError } from "../../logging/request-log.ts";
import { clearBufferedLogEvents, getBufferedLogEvents } from "../../logging/index.ts";

/** Generate a DiceBear avatar URL using a hash of the email as seed */
function generateDefaultAvatar(email: string): string {
  const normalized = email.trim().toLowerCase();
  let hash = 0;
  for (let i = 0; i < normalized.length; i++) {
    hash = (hash << 5) - hash + normalized.charCodeAt(i);
    hash |= 0;
  }
  return `https://api.dicebear.com/9.x/notionists/svg?seed=${Math.abs(hash).toString(36)}`;
}

const ThrowableKind = z.enum(["string", "error", "custom-error", "error-with-detail"]);

const FailureMechanism = z.enum(["throw", "logger-error", "logger-warn"]);

export const FailureScenario = z.object({
  marker: z.string(),
  throwable: ThrowableKind,
  mechanism: FailureMechanism,
});
export type FailureScenario = z.infer<typeof FailureScenario>;

/**
 * Testing router - provides helpers for test setup
 * These endpoints are only available in non-production environments
 */
export const testingRouter = {
  // Trigger query invalidation broadcast (for e2e tests)
  triggerInvalidation: publicMutation.handler(async () => {
    if (!isNonProd) {
      throw new ORPCError("FORBIDDEN", {
        message: "Testing endpoints are not available in production",
      });
    }
    return { triggered: true, timestamp: new Date().toISOString() };
  }),

  emitRequestFailure: publicProcedure.input(FailureScenario).handler(({ input }) => {
    if (!isNonProd) {
      throw new ORPCError("FORBIDDEN", {
        message: "Testing endpoints are not available in production",
      });
    }

    runTestingFailureScenario(input);
    return { logged: true };
  }),

  emitWaitUntilFailure: publicProcedure.input(FailureScenario).handler(({ input }) => {
    if (!isNonProd) {
      throw new ORPCError("FORBIDDEN", {
        message: "Testing endpoints are not available in production",
      });
    }

    waitUntil(async () => {
      await Promise.resolve();
      runTestingFailureScenario(input);
    });

    return { scheduled: true };
  }),

  emitSuccessfulOutboxEvent: publicProcedure
    .input(z.object({ message: z.string() }))
    .handler(async ({ context: ctx, input }) => {
      if (!isNonProd) {
        throw new ORPCError("FORBIDDEN", {
          message: "Testing endpoints are not available in production",
        });
      }

      const output = await ctx.db.transaction(async (tx) => {
        const result = await tx.execute(sql`select now()::text as now`);
        const rows = result.rows as { now: string }[];
        const dbtime = rows[0]?.now ?? new Date().toISOString();
        return ctx.sendEvent(tx, { dbtime, message: input.message });
      });

      const processResult = await queuer.processQueue(ctx.db);
      return { ...output, processResult };
    }),

  emitOutboxFailure: publicProcedure
    .input(FailureScenario)
    .handler(async ({ context: ctx, input }) => {
      if (!isNonProd) {
        throw new ORPCError("FORBIDDEN", {
          message: "Testing endpoints are not available in production",
        });
      }

      const output = await ctx.db.transaction(async (tx) => {
        const result = await tx.execute(sql`select now()::text as now`);
        const rows = result.rows as { now: string }[];
        const dbtime = rows[0]?.now ?? new Date().toISOString();
        return ctx.sendEvent(tx, { dbtime, ...input });
      });

      const processResult = await queuer.processQueue(ctx.db);
      return { ...output, processResult };
    }),

  processOutboxQueue: publicProcedure.handler(async ({ context: ctx }) => {
    if (!isNonProd) {
      throw new ORPCError("FORBIDDEN", {
        message: "Testing endpoints are not available in production",
      });
    }

    return await queuer.processQueue(ctx.db);
  }),

  purgeOutboxQueue: publicProcedure.handler(async ({ context: ctx }) => {
    if (!isNonProd) {
      throw new ORPCError("FORBIDDEN", {
        message: "Testing endpoints are not available in production",
      });
    }

    await ctx.db.execute(sql`select pgmq.purge_queue('consumer_job_queue')`);
    return { ok: true };
  }),

  clearBufferedLogs: publicProcedure.handler(() => {
    if (!isNonProd) {
      throw new ORPCError("FORBIDDEN", {
        message: "Testing endpoints are not available in production",
      });
    }

    clearBufferedLogEvents();
    return { ok: true };
  }),

  getBufferedLogs: publicProcedure.handler(() => {
    if (!isNonProd) {
      throw new ORPCError("FORBIDDEN", {
        message: "Testing endpoints are not available in production",
      });
    }

    return { logs: getBufferedLogEvents() };
  }),

  insertMalformedOutboxJob: publicProcedure
    .input(z.object({ marker: z.string() }))
    .handler(async ({ context: ctx, input }) => {
      if (!isNonProd) {
        throw new ORPCError("FORBIDDEN", {
          message: "Testing endpoints are not available in production",
        });
      }

      await ctx.db.execute(sql`
        select * from pgmq.send(
          queue_name => 'consumer_job_queue',
          msg => ${JSON.stringify({
            nope: true,
            marker: input.marker,
            event_context: getTestingEventContext(ctx),
          })}::jsonb
        )
      `);

      const processResult = await queuer.processQueue(ctx.db);
      return { inserted: true, processResult };
    }),

  insertMissingConsumerOutboxJob: publicProcedure
    .input(z.object({ marker: z.string() }))
    .handler(async ({ context: ctx, input }) => {
      if (!isNonProd) {
        throw new ORPCError("FORBIDDEN", {
          message: "Testing endpoints are not available in production",
        });
      }

      await ctx.db.execute(sql`
        select * from pgmq.send(
          queue_name => 'consumer_job_queue',
          msg => ${JSON.stringify({
            consumer_name: `missing-consumer-${input.marker}`,
            status: "pending",
            event_name: `testing:missing-consumer:${input.marker}`,
            event_id: 999999,
            event_payload: { marker: input.marker },
            event_context: getTestingEventContext(ctx),
            processing_results: [],
            environment: process.env.APP_STAGE || process.env.NODE_ENV || "unknown",
          })}::jsonb
        )
      `);

      const processResult = await queuer.processQueue(ctx.db);
      return { inserted: true, processResult };
    }),

  // Create test user (for e2e tests)
  createTestUser: publicProcedure
    .input(
      z.object({
        email: z.string().email(),
        name: z.string(),
        role: z.enum(["user", "admin"]).default("user"),
      }),
    )
    .handler(async ({ context: ctx, input }) => {
      if (!isNonProd) {
        throw new ORPCError("FORBIDDEN", {
          message: "Testing endpoints are not available in production",
        });
      }
      const [newUser] = await ctx.db
        .insert(user)
        .values({
          email: input.email,
          name: input.name,
          role: input.role,
          emailVerified: true,
          image: generateDefaultAvatar(input.email),
        })
        .onConflictDoUpdate({
          target: user.email,
          set: {
            name: input.name,
            role: input.role,
          },
        })
        .returning();

      return newUser;
    }),

  // Create test organization with project
  createTestOrganization: protectedProcedure
    .input(
      z.object({
        name: z.string(),
        projectName: z.string().optional(),
      }),
    )
    .handler(async ({ context: ctx, input }) => {
      if (!isNonProd) {
        throw new ORPCError("FORBIDDEN", {
          message: "Testing endpoints are not available in production",
        });
      }
      const orgSlug = slugifyWithSuffix(input.name);

      const [newOrg] = await ctx.db
        .insert(organization)
        .values({
          name: input.name,
          slug: orgSlug,
        })
        .returning();

      if (!newOrg) {
        throw new Error("Failed to create organization");
      }

      await ctx.db.insert(organizationUserMembership).values({
        organizationId: newOrg.id,
        userId: ctx.user.id,
        role: "owner",
      });

      const projSlug = slugifyWithSuffix(input.projectName || "default");
      const sandboxProvider = getDefaultProjectSandboxProvider(ctx.env, import.meta.env.DEV);
      const [newProject] = await ctx.db
        .insert(project)
        .values({
          name: input.projectName || "Default Project",
          slug: projSlug,
          organizationId: newOrg.id,
          sandboxProvider,
        })
        .returning();

      return {
        organization: newOrg,
        project: newProject,
      };
    }),

  // Clean up test data
  cleanupTestData: publicProcedure
    .input(
      z.object({
        email: z.string().email().optional(),
        organizationSlug: z.string().optional(),
      }),
    )
    .handler(async ({ context: ctx, input }) => {
      if (!isNonProd) {
        throw new ORPCError("FORBIDDEN", {
          message: "Testing endpoints are not available in production",
        });
      }
      const results: string[] = [];

      if (input.email) {
        const deleted = await ctx.db.delete(user).where(eq(user.email, input.email)).returning();
        results.push(`Deleted ${deleted.length} users`);
      }

      if (input.organizationSlug) {
        const deleted = await ctx.db
          .delete(organization)
          .where(eq(organization.slug, input.organizationSlug))
          .returning();
        results.push(`Deleted ${deleted.length} organizations`);
      }

      return { results };
    }),

  // Seed Slack project connection for tests
  seedSlackConnection: projectProtectedProcedure
    .input(
      z.object({
        ...ProjectInput.shape,
        teamId: z.string().min(1),
        teamName: z.string().optional(),
        teamDomain: z.string().optional(),
      }),
    )
    .handler(async ({ context: ctx, input }) => {
      if (!isNonProd) {
        throw new ORPCError("FORBIDDEN", {
          message: "Testing endpoints are not available in production",
        });
      }

      const existingConnection = await ctx.db.query.projectConnection.findFirst({
        where: (pc, { eq, and }) => and(eq(pc.projectId, ctx.project.id), eq(pc.provider, "slack")),
      });

      const providerData = {
        teamId: input.teamId,
        teamName: input.teamName ?? input.teamId,
        teamDomain: input.teamDomain ?? input.teamId,
      };

      if (existingConnection) {
        await ctx.db
          .update(projectConnection)
          .set({
            externalId: input.teamId,
            providerData,
          })
          .where(eq(projectConnection.id, existingConnection.id));
      } else {
        await ctx.db.insert(projectConnection).values({
          projectId: ctx.project.id,
          provider: "slack",
          externalId: input.teamId,
          scope: "project",
          userId: ctx.user.id,
          providerData,
        });
      }

      return { success: true };
    }),
};

class TestingCustomError extends Error {
  exampleField: string;

  constructor(exampleField: string, message: string) {
    super(message);
    this.exampleField = exampleField;
  }
}

/** Emit one synthetic failure shape for logging integration coverage. */
export function runTestingFailureScenario(input: FailureScenario): void {
  const throwable = createTestingThrowable(input);
  const message = throwable instanceof Error ? throwable.message : String(throwable);

  switch (input.mechanism) {
    case "throw":
      throw throwable;
    case "logger-error":
      logger.error(message, throwable);
      return;
    case "logger-warn":
      logger.set({ errors: [toParsedLogError(throwable)] });
      logger.warn(message);
      return;
  }
}

/** Build a representative throwable for the requested test scenario. */
export function createTestingThrowable(input: FailureScenario): string | Error {
  const message = `[test_${input.throwable.replaceAll("-", "_")}] ${input.marker}`;

  switch (input.throwable) {
    case "string":
      return message;
    case "error":
      return new Error(message);
    case "custom-error":
      return new TestingCustomError(input.marker, message);
    case "error-with-detail":
      return Object.assign(new Error(message), { detail: { bar: 123 } });
  }
}

function getTestingEventContext(ctx: { rawRequest: Request }): Record<string, unknown> {
  const posthogEgressOverride = ctx.rawRequest.headers.get("x-replace-posthog-egress");
  if (!posthogEgressOverride) return {};

  return {
    telemetry: {
      egress: {
        ["https://eu.i.posthog.com"]: posthogEgressOverride,
      },
    },
  };
}
