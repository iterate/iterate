import { agentsRouter } from "../agent/agents-router.ts";
import { router } from "./trpc.ts";
import { integrationsRouter } from "./routers/integrations.ts";

export const appRouter = router({
  integrations: integrationsRouter,
  agents: agentsRouter,
});

export type AppRouter = typeof appRouter;
