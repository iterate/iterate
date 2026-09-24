import { dashEnvs } from "../../../envs.ts";
import { startAppCli } from "../../../scripts/lib/start-app.ts";

/** apps/dash as scripts/lib/start-app.ts sees it: the package scripts and vite.config.ts run off this.
 *  On a custom domain: its route and DNS record follow from the baseUrl in envs.ts. */
export const dash = {
  name: "dash",
  root: new URL("..", import.meta.url),
  envs: dashEnvs,
  nothingToErase:
    "Dash owns no server data; sessions, projects and organizations belong to the platform.",
};
if (process.argv[1]?.endsWith("app.ts")) void startAppCli(dash).run();
