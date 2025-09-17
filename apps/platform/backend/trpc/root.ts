import { agentsRouter } from "../agent/agents-router.ts";
import { router } from "./trpc.ts";
import { integrationsRouter } from "./routers/integrations.ts";
import { estateRouter } from "./routers/estate.ts";

export const appRouter = router({
  integrations: integrationsRouter,
  agents: agentsRouter,
  estate: estateRouter,
});

export type AppRouter = typeof appRouter;
