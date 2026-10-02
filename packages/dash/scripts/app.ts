import { dashEnvs } from "../../../envs.ts";
import { startAppCli } from "../../../scripts/lib/start-app.ts";

/** packages/dash as scripts/lib/start-app.ts sees it: the package scripts and vite.config.ts run off this.
 *  On a custom domain: its route and DNS record follow from the baseUrl in envs.ts. */
export const dash = {
  name: "dash",
  dopplerProject: "dash",
  root: new URL("..", import.meta.url),
  envs: dashEnvs,
};
if (import.meta.main) void startAppCli(dash).run();
