import { z } from "zod";
import { eq } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { typeid } from "typeid-js";
import { protectedProcedureWithNoEstateRestrictions, router } from "../trpc.ts";
import { getAuth } from "../../auth/auth.ts";
import { testAdminUser } from "../../auth/test-admin.ts";
import { schema } from "../../db/client.ts";
import { createUserOrganizationAndEstate } from "../../org-utils.ts";
import { getOctokitForInstallation } from "../../integrations/github/github-utils.ts";
import { env } from "../../../env.ts";

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

const createAdminUser = testingProcedure
  .input(
    z.object({
      email: z.string().default(testAdminUser.email!),
      password: z.string().default(testAdminUser.password!),
      name: z.string().optional(),
    }),
  )
  .mutation(async ({ ctx, input }) => {
    const getFromDb = () =>
      ctx.db.query.user.findFirst({
        where: eq(schema.user.email, input.email),
      });
    const existing = await getFromDb();
    if (existing) {
      return { created: false, user: existing }; // hope ur password is right, good luck
    }
    const auth = getAuth(ctx.db);
    const _user = await auth.api
      .createUser({
        body: {
          role: "admin",
          name: input.name ?? input.email.split("@")[0],
          email: input.email,
          password: input.password,
        },
      })
      .catch(async (e) => {
        if (e.message.includes("already exists")) {
          return { created: false };
        }
        throw e;
      });
    return { created: true, user: await getFromDb() };
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

export const createOrganizationAndEstate = testingProcedure
  .input(
    z.object({
      userId: z.string(),
    }),
  )
  .mutation(async ({ ctx, input }) => {
    const user = await ctx.db.query.user.findFirst({
      where: eq(schema.user.id, input.userId),
    });
    if (!user) throw new TRPCError({ code: "NOT_FOUND", message: "User not found" });

    const { organization, estate } = await createUserOrganizationAndEstate(ctx.db, user);

    if (!estate) throw new Error("Failed to create estate");

    return { organization, estate };
  });

export const deleteOrganization = testingProcedure
  .input(z.object({ organizationId: z.string() }))
  .mutation(async ({ ctx, input }) => {
    await ctx.db
      .delete(schema.organization)
      .where(eq(schema.organization.id, input.organizationId));
  });

export const deleteIterateManagedRepo = testingProcedure
  .input(z.object({ repoFullName: z.string() }))
  .mutation(async ({ input }) => {
    const [owner, repoName] = input.repoFullName.split("/");
    const octokit = await getOctokitForInstallation(env.GITHUB_ESTATES_DEFAULT_INSTALLATION_ID);
    await octokit.rest.repos.delete({ owner, repo: repoName });
  });

export const testingRouter = router({
  createAdminUser,
  setUserRole,
  createTestUser,
  createOrganizationAndEstate,
  deleteOrganization,
  deleteIterateManagedRepo,
});
