import { z } from "zod";
import { eq } from "drizzle-orm";
import { publicProcedure, router } from "../trpc.ts";
import { getAuth } from "../../auth/auth.ts";
import { getDb, schema } from "../../db/client.ts";

const createAdminUser = publicProcedure
  .input(
    z.object({
      email: z.string().default("admin@example.com"),
      password: z.string().default("password"),
      name: z.string().optional(),
    }),
  )
  .mutation(async ({ ctx, input }) => {
    const existing = await ctx.db.query.user.findFirst({
      where: eq(schema.user.email, input.email),
    });
    if (existing) {
      return { created: false }; // hope ur password is right, good luck
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
    return { created: true };
  });

const setUserRole = publicProcedure
  .input(
    z.object({
      email: z.string(),
      role: z.enum(["admin", "user"]),
    }),
  )
  .mutation(async ({ input }) => {
    const result = await getDb()
      .update(schema.user)
      .set({ role: input.role })
      .where(eq(schema.user.email, input.email))
      .returning();
    return { success: true, result };
  });

/** At compile time, this router will be usable, but if you try to use it in production the procedures just won't exist (`as never`) */
export const testingRouter = import.meta.env.VITE_ENABLE_TEST_ADMIN_USER
  ? router({
      createAdminUser,
      setUserRole,
    })
  : (router({}) as never);
