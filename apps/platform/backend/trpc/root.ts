import { router } from "./trpc.ts";
import { integrationsRouter } from "./routers/integrations.ts";

export const appRouter = router({
  integrations: integrationsRouter,
});

export type AppRouter = typeof appRouter;
