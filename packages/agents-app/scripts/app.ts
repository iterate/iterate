import { agentsEnvs } from "../../../envs.ts";
import { startAppCli } from "../../../scripts/lib/start-app.ts";

/** packages/agents-app as scripts/lib/start-app.ts sees it: the package scripts and vite.config.ts run off this. */
export const agents = {
  name: "agents",
  dopplerProject: "agents",
  root: new URL("..", import.meta.url),
  envs: agentsEnvs,
};
if (import.meta.main) void startAppCli(agents).run();
