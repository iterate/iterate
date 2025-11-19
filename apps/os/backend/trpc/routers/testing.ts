import { z } from "zod";
import { eq } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { publicProcedure, router } from "../trpc.ts";
import { getAuth } from "../../auth/auth.ts";
import { testAdminUser } from "../../auth/test-admin.ts";
import { schema } from "../../db/client.ts";

const testingProcedure = publicProcedure.use(({ next }) => {
  if (!testAdminUser.enabled) {
    // shouldn't ever hit, but if someone accidentally enables the whole router in production, throw an error
    throw new TRPCError({
      code: "UNAUTHORIZED",
      cause: new Error(
        `Test admin user is not enabled, is this procedure somehow being called in production? That's bad.`,
      ),
    });
  }
  return next();
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

const testEventable = publicProcedure
  .input(z.object({ message: z.string() }))
  .mutation(async ({ input, ctx }) => {
    return ctx.db.transaction(async (tx) => {
      return ctx.sendToOutbox(tx, { greeting: `Hello, ${input.message}!` });
    });
  });

/** At compile time, this router will be usable, but if you try to use it in production the procedures just won't exist (`as never`) */
export const testingRouter = testAdminUser.enabled
  ? router({ createAdminUser, setUserRole, testEventable })
  : (router({}) as never);
