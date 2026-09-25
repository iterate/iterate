import { isMainModule } from "@iterate-com/shared/dev/is-main-module";
import { agentsEnvs } from "../../../envs.ts";
import { startAppCli } from "../../../scripts/lib/start-app.ts";

/** apps/agents as scripts/lib/start-app.ts sees it: the package scripts and vite.config.ts run off this. */
export const agents = {
  name: "agents",
  root: new URL("..", import.meta.url),
  envs: agentsEnvs,
};
if (isMainModule(import.meta.url)) void startAppCli(agents).run();
