import { os } from "./orpc.ts";
import { internal } from "./routers/internal.ts";
import { organization } from "./routers/organization.ts";
import { project } from "./routers/project.ts";
import { superadmin } from "./routers/superadmin.ts";
import { user } from "./routers/user.ts";

export const appRouter = os.router({
  user,
  organization,
  project,
  superadmin,
  internal,
});

export type AppRouter = typeof appRouter;
