import { router } from "./trpc.ts";
import { userRouter } from "./routers/user.ts";
import { organizationRouter } from "./routers/organization.ts";
import { projectRouter } from "./routers/project.ts";
import { machineRouter } from "./routers/machine.ts";
import { adminRouter } from "./routers/admin.ts";
import { testingRouter } from "./routers/testing.ts";
import { envVarRouter } from "./routers/env-var.ts";
import { accessTokenRouter } from "./routers/access-token.ts";
import { billingRouter } from "./routers/billing.ts";
import { eventRouter } from "./routers/event.ts";
import { secretRouter } from "./routers/secret.ts";

export const appRouter = router({
  user: userRouter,
  organization: organizationRouter,
  project: projectRouter,
  machine: machineRouter,
  admin: adminRouter,
  testing: testingRouter,
  envVar: envVarRouter,
  accessToken: accessTokenRouter,
  billing: billingRouter,
  event: eventRouter,
  secret: secretRouter,
});

export type AppRouter = typeof appRouter;
