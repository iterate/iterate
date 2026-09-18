import { agentsEnvs } from "../../../envs.ts";
import { startAppCli } from "../../../scripts/lib/start-app.ts";

/** apps/agents as scripts/lib/start-app.ts sees it: the package scripts and vite.config.ts run off this. */
export const agents = {
  name: "agents",
  root: new URL("..", import.meta.url),
  envs: agentsEnvs,
  nothingToErase: "Agents owns no server data; agents belong to their projects.",
};
if (process.argv[1]?.endsWith("app.ts")) void startAppCli(agents).run();
