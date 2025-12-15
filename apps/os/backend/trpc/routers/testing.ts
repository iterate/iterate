import { z } from "zod";
import { eq, ne, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { typeid } from "typeid-js";
import { protectedProcedureWithNoEstateRestrictions, publicProcedure, router } from "../trpc.ts";
import { getAuth } from "../../auth/auth.ts";
import { schema } from "../../db/client.ts";
import { createUserOrganizationAndInstallation } from "../../org-utils.ts";
import { getOctokitForInstallation } from "../../integrations/github/github-utils.ts";
import { env } from "../../../env.ts";
import { saveSlackUsersToDatabase } from "../../integrations/slack/slack.ts";
import { AGENT_CLASS_NAMES, getAgentStubByName } from "../../agent/agents/stub-getters.ts";
import type { IterateAgent, SlackAgent } from "../../worker.ts";
import { queuer } from "../../outbox/outbox-queuer.ts";

const testingProcedure = protectedProcedureWithNoEstateRestrictions.use(({ ctx, next }) => {
  if (ctx.user.role !== "admin") {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "You are not authorized to access this resource",
    });
  }
  if (ctx.user.email !== "admin-npc@nustom.com") {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Only the superadmin NPC is allowed to access this resource",
    });
  }
  return next({ ctx });
});

const testingAgentProcedure = testingProcedure
  .input(
    z.object({
      installationId: z.string(),
      agentClassName: z.enum(AGENT_CLASS_NAMES),
      agentInstanceName: z.string(),
    }),
  )
  .use(async ({ input, ctx, next }) => {
    const installationId = input.installationId;

    const agent = await getAgentStubByName(input.agentClassName, {
      db: ctx.db,
      agentInstanceName: input.agentInstanceName,
      installationId,
    }).catch((err) => {
      // todo: effect!
      if (String(err).includes("not found")) {
        throw new TRPCError({ code: "NOT_FOUND", message: String(err), cause: err });
      }
      throw err;
    });

    // agent.getEvents() is "never" at this point because of cloudflare's helpful type restrictions. we want it to be correctly inferred as "some subclass of IterateAgent"

    return next({
      ctx: {
        ...ctx,
        agent: agent as {} as Omit<typeof agent, "getEvents"> & {
          // todo: figure out why cloudflare doesn't like the return type of getEvents - it neverifies it becaue of something that can't cross the boundary?
          // although this is still useful anyway, to help remind us to always call `await` even though if calling getEvents in-process, it's synchronous
          getEvents: () => Promise<ReturnType<IterateAgent["getEvents"]>>;
        },
      },
    });
  });

const setUserRole = testingProcedure
  .input(
    z.object({
      email: z.string(),
      role: z.enum(["admin", "user"]),
    }),
  )
  .mutation(async ({ ctx, input }) => {
    const result = await ctx.db
      .update(schema.user)
      .set({ role: input.role })
      .where(eq(schema.user.email, input.email))
      .returning();
    return { success: true, result };
  });

export const createTestUser = testingProcedure
  .input(
    z.object({
      email: z.string().optional(),
      name: z.string().optional(),
      password: z.string().optional(),
    }),
  )
  .mutation(async ({ ctx, input }) => {
    const {
      email = `${typeid("test_user")}@example.com`,
      name = email.split("@")[0],
      password = typeid("pass").toString(),
    } = input;
    const auth = getAuth(ctx.db);
    const { user } = await auth.api.createUser({
      body: { email, name, role: "user", password },
    });
    return { user };
  });

export const createOrganizationAndInstallation = testingProcedure
  .input(
    z.object({
      userId: z.string(),
      /** If true, mark onboarding as completed so the estate doesn't redirect to onboarding flow */
      skipOnboarding: z.boolean().default(true),
    }),
  )
  .mutation(async ({ ctx, input }) => {
    const user = await ctx.db.query.user.findFirst({
      where: eq(schema.user.id, input.userId),
    });
    if (!user) throw new TRPCError({ code: "NOT_FOUND", message: "User not found" });

    const { organization, installation } = await createUserOrganizationAndInstallation(
      ctx.db,
      user,
    );

    if (!installation) throw new Error("Failed to create installation");

    // Mark onboarding as completed to avoid redirecting to onboarding flow
    if (input.skipOnboarding) {
      await ctx.db.insert(schema.installationOnboardingEvent).values({
        installationId: installation.id,
        organizationId: organization.id,
        eventType: "OnboardingCompleted",
        category: "system",
        detail: "Skipped for testing",
      });
    }

    return { organization, installation };
  });

export const deleteOrganization = testingProcedure
  .input(z.object({ organizationId: z.string() }))
  .mutation(async ({ ctx, input }) => {
    await queuer.processQueue(ctx.db);
    await ctx.db.transaction(async (tx) => {
      const installations = await tx.query.installation.findMany({
        where: eq(schema.installation.organizationId, input.organizationId),
      });
      const installationsDeleted = await tx
        .delete(schema.installation)
        .where(eq(schema.installation.organizationId, input.organizationId))
        .returning();
      const consumerJobs = await tx.execute(sql`
        delete from pgmq.q_consumer_job_queue
        where
          -- https://www.postgresql.org/docs/9.4/functions-json.html#FUNCTIONS-JSONB-OP-TABLE
          ${JSON.stringify(installations.map((e) => e.id))}::jsonb ? (message->'event_payload'->>'installationId')
        returning *
      `);
      const organizationDeleted = await tx
        .delete(schema.organization)
        .where(eq(schema.organization.id, input.organizationId))
        .returning();
      return {
        installationsDeleted: installationsDeleted.length,
        consumerJobs: consumerJobs.length,
        organizationDeleted: organizationDeleted.length,
      };
    });
  });

export const deleteIterateManagedRepo = testingProcedure
  .input(z.object({ repoFullName: z.string() }))
  .mutation(async ({ input }) => {
    const [owner, repoName] = input.repoFullName.split("/");
    const octokit = await getOctokitForInstallation(env.GITHUB_ESTATES_DEFAULT_INSTALLATION_ID);
    await octokit.rest.repos.delete({ owner, repo: repoName });
  });

const SlackMemberInfo = z.object({
  id: z.string(),
  name: z.string().optional(),
  real_name: z.string().optional(),
  is_bot: z.boolean().optional(),
  is_restricted: z.boolean().optional(),
  is_ultra_restricted: z.boolean().optional(),
  profile: z
    .object({
      email: z.string().optional(),
      image_192: z.string().optional(),
    })
    .optional(),
});

export const addSlackUsersToInstallation = testingProcedure
  .input(
    z.object({
      installationId: z.string(),
      teamId: z.string().default("TEST_TEAM"),
      members: z.array(SlackMemberInfo),
      /** If provided, all Slack users will be linked to this iterate user ID
       * instead of creating new user records. This is useful for tests where
       * the Slack user needs to match the logged-in user. */
      linkToUserId: z.string().optional(),
    }),
  )
  .mutation(async ({ ctx, input }) => {
    // First save the users normally (this creates user records and mappings)
    await saveSlackUsersToDatabase(ctx.db, input.members, input.installationId, input.teamId);

    // If linkToUserId is provided, update the mappings to point to that user
    if (input.linkToUserId) {
      for (const member of input.members) {
        await ctx.db
          .insert(schema.providerUserMapping)
          .values({
            providerId: "slack-bot",
            externalId: member.id,
            internalUserId: input.linkToUserId,
            installationId: input.installationId,
            externalUserTeamId: input.teamId,
          })
          .onConflictDoUpdate({
            target: [
              schema.providerUserMapping.providerId,
              schema.providerUserMapping.installationId,
              schema.providerUserMapping.externalId,
            ],
            set: {
              internalUserId: input.linkToUserId,
              externalUserTeamId: input.teamId,
            },
          });
      }
    }

    return { success: true, memberCount: input.members.length };
  });

export const setupTeamId = testingProcedure
  .input(z.object({ installationId: z.string(), teamId: z.string() }))
  .mutation(async ({ ctx, input }) => {
    await ctx.db
      .insert(schema.providerInstallationMapping)
      .values([
        {
          providerId: "slack-bot",
          internalInstallationId: input.installationId,
          externalId: input.teamId,
        },
      ])
      .onConflictDoUpdate({
        target: [
          schema.providerInstallationMapping.providerId,
          schema.providerInstallationMapping.externalId,
        ],
        set: {
          internalInstallationId: input.installationId,
          externalId: input.teamId,
        },
      });
    return { success: true };
  });

export const testingRouter = router({
  nuke: testingProcedure.mutation(async ({ ctx }) => {
    await ctx.db.transaction(async (tx) => {
      await tx.delete(schema.installationOnboardingEvent);
      await tx.delete(schema.organization);
      await tx.delete(schema.user).where(ne(schema.user.id, ctx.user.id));
    });
  }),
  createSuperAdminUser: publicProcedure
    .input(
      z.object({
        serviceAuthToken: z.string(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (input.serviceAuthToken !== env.SERVICE_AUTH_TOKEN) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Invalid service auth token" });
      }
      const db = ctx.db;
      const user = await db.query.user.findFirst({
        where: eq(schema.user.email, "admin-npc@nustom.com"),
      });
      if (user) {
        return { created: false, user };
      }
      const [newUser] = await db
        .insert(schema.user)
        .values({
          email: "admin-npc@nustom.com",
          name: "Super Admin",
          role: "admin",
          emailVerified: true,
          debugMode: true,
        })
        .returning();
      return { created: true, user: newUser };
    }),
  mockSlackAPI: testingAgentProcedure.mutation(async ({ ctx, input }) => {
    const agent = await getAgentStubByName(input.agentClassName, {
      db: ctx.db,
      agentInstanceName: input.agentInstanceName,
      installationId: input.installationId,
    });
    await (agent as {} as SlackAgent).mockSlackAPI();
    return { success: true };
  }),
  cleanupOutbox: testingProcedure.mutation(async ({ ctx }) => {
    await ctx.db.execute(sql`
      delete from pgmq.q_consumer_job_queue
      where
        message->'event_payload'->>'installationId' is not null
        and message->'event_payload'->>'installationId' not in (select id from installation)
    `);
  }),
  setUserRole,
  createTestUser,
  createOrganizationAndInstallation,
  deleteOrganization,
  deleteIterateManagedRepo,
  addSlackUsersToInstallation,
  setupTeamId,
});
