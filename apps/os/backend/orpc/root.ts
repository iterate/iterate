import { userRouter } from "./routers/user.ts";
import { organizationRouter } from "./routers/organization.ts";
import { projectRouter } from "./routers/project.ts";
import { machineRouter } from "./routers/machine.ts";
import { adminRouter } from "./routers/admin.ts";
import { testingRouter } from "./routers/testing.ts";
import { envVarRouter } from "./routers/env-var.ts";
import { accessTokenRouter } from "./routers/access-token.ts";
import { billingRouter } from "./routers/billing.ts";
import { secretRouter } from "./routers/secret.ts";
import { webchatRouter } from "./routers/webchat.ts";
import { deploymentRouter } from "./routers/deployment.ts";

/** oRPC app router — plain object assembling all sub-routers */
export const appRouter = {
  user: userRouter,
  organization: organizationRouter,
  project: projectRouter,
  machine: machineRouter,
  admin: adminRouter,
  testing: testingRouter,
  envVar: envVarRouter,
  accessToken: accessTokenRouter,
  billing: billingRouter,
  secret: secretRouter,
  webchat: webchatRouter,
  deployment: deploymentRouter,
};

export type AppRouter = typeof appRouter;
