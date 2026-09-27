import { isMainModule } from "@iterate-com/shared/dev/is-main-module";
import { kitEnvs } from "../../../envs.ts";
import { startAppCli } from "../../../scripts/lib/start-app.ts";

/** apps/kit as scripts/lib/start-app.ts sees it: the package scripts and vite.config.ts run off this. */
export const kit = {
  name: "kit",
  root: new URL("..", import.meta.url),
  envs: kitEnvs,
};
if (isMainModule(import.meta.url)) void startAppCli(kit).run();
