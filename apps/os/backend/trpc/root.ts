import { agentsRouter } from "../agent/agents-router.ts";
import { stripeRouter } from "../integrations/stripe/trpc-procedures.ts";
import { router } from "./trpc.ts";
import { integrationsRouter } from "./routers/integrations.ts";
import { estateRouter } from "./routers/estate.ts";
import { estatesRouter } from "./routers/estates.ts";
import { userRouter } from "./routers/user.ts";
import { testingRouter } from "./routers/testing.ts";
import { adminRouter } from "./routers/admin.ts";
import { organizationRouter } from "./routers/organization.ts";
import { trialRouter } from "./routers/trial.ts";

export const appRouter = router({
  integrations: integrationsRouter,
  agents: agentsRouter,
  estate: estateRouter,
  estates: estatesRouter,
  user: userRouter,
  admin: adminRouter,
  testing: testingRouter,
  stripe: stripeRouter,
  organization: organizationRouter,
  trial: trialRouter,
});

export type AppRouter = typeof appRouter;
