import { z } from "zod";
import { publicProcedure, router } from "../trpc.ts";
import { getAuth } from "../../auth/auth.ts";

const createAdminUser = publicProcedure
  .input(
    z.object({
      email: z.string().default("admin@example.com"),
      password: z.string().default("password"),
      name: z.string().optional(),
    }),
  )
  .mutation(async ({ ctx, input }) => {
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
          // const users = await auth.api.lis;
          // return users.users[0];
          return { created: false };
        }
        throw e;
      });
    return { created: true };
  });

/** At compile time, this router will be usable, but if you try to use it in production the procedures just won't exist (`as never`) */
export const testingRouter = import.meta.env.VITE_ENABLE_TEST_ADMIN_USER
  ? router({
      createAdminUser,
    })
  : (router({}) as never);
