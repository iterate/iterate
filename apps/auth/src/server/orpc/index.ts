import { os } from "./orpc.ts";
import { superadmin } from "./routers/superadmin.ts";

export const appRouter = os.router({
  superadmin,
});

export type AppRouter = typeof appRouter;
