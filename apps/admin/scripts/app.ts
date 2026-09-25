import { adminEnvs } from "../../../envs.ts";
import { startAppCli } from "../../../scripts/lib/start-app.ts";

/** apps/admin as scripts/lib/start-app.ts sees it: the package scripts and vite.config.ts run off this. */
export const admin = {
  name: "admin",
  root: new URL("..", import.meta.url),
  envs: adminEnvs,
};
if (process.argv[1]?.endsWith("app.ts")) void startAppCli(admin).run();
