import { router } from "./trpc.ts";
import { userRouter } from "./routers/user.ts";
import { organizationRouter } from "./routers/organization.ts";
import { projectRouter } from "./routers/project.ts";
import { machineRouter } from "./routers/machine.ts";
import { adminRouter } from "./routers/admin.ts";
import { testingRouter } from "./routers/testing.ts";

export const appRouter = router({
  user: userRouter,
  organization: organizationRouter,
  project: projectRouter,
  machine: machineRouter,
  admin: adminRouter,
  testing: testingRouter,
});

export type AppRouter = typeof appRouter;
