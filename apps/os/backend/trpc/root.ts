import { agentsRouter } from "../agent/agents-router.ts";
import { router } from "./trpc.ts";
import { integrationsRouter } from "./routers/integrations.ts";
import { estateRouter } from "./routers/estate.ts";
import { estatesRouter } from "./routers/estates.ts";
import { userRouter } from "./routers/user.ts";
import { testingRouter } from "./routers/testing.ts";

export const appRouter = router({
  integrations: integrationsRouter,
  agents: agentsRouter,
  estate: estateRouter,
  estates: estatesRouter,
  user: userRouter,
  testing: testingRouter,
});

export type AppRouter = typeof appRouter;
