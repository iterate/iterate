import { adminEnvs } from "../../../envs.ts";
import { startAppCli } from "../../../scripts/lib/start-app.ts";

/** packages/admin as scripts/lib/start-app.ts sees it: the package scripts and vite.config.ts run off this. */
export const admin = {
  name: "admin",
  dopplerProject: "admin",
  root: new URL("..", import.meta.url),
  envs: adminEnvs,
};
if (import.meta.main) void startAppCli(admin).run();
