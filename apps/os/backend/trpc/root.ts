import { agentsRouter } from "../agent/agents-router.ts";
import { getAuth } from "../auth/auth.ts";
import { publicProcedure, router } from "./trpc.ts";
import { integrationsRouter } from "./routers/integrations.ts";
import { estateRouter } from "./routers/estate.ts";
import { estatesRouter } from "./routers/estates.ts";
import { userRouter } from "./routers/user.ts";

export const appRouter = router({
  integrations: integrationsRouter,
  agents: agentsRouter,
  estate: estateRouter,
  estates: estatesRouter,
  user: userRouter,
  test: publicProcedure.mutation(async ({ ctx }) => {
    const auth = getAuth(ctx.db);
    const admin = await auth.api
      .createUser({
        body: {
          email: "admin@example.com",
          name: "Admin",
          password: "password",
          role: "admin",
        },
      })
      .catch(async (e) => {
        if (e.message.includes("already exists")) {
          // const users = await auth.api.lis;
          // return users.users[0];
          return {};
        }
        throw e;
      });
    return admin;
  }),
});

export type AppRouter = typeof appRouter;
