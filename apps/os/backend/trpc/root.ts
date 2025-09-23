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
  test: import.meta.env.VITE_ENABLE_TEST_ADMIN_USER
    ? publicProcedure.mutation(async ({ ctx }) => {
        const auth = getAuth(ctx.db);
        const admin = await auth.api
          .createUser({
            body: {
              name: "Admin",
              email: "admin@example.com",
              password: "password",
              role: "admin",
            },
            returnHeaders,
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
      })
    : ({} as never),
});

export type AppRouter = typeof appRouter;
