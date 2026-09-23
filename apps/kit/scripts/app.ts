import { kitEnvs } from "../../../envs.ts";
import { startAppCli } from "../../../scripts/lib/start-app.ts";
import { deployKit } from "./deploy.ts";

/** apps/kit as scripts/lib/start-app.ts sees it: the package scripts and vite.config.ts run off this.
 *  Its deploy is its own — it ships the firmware binaries beside the installer (deploy.ts). */
export const kit = {
  name: "kit",
  root: new URL("..", import.meta.url),
  envs: kitEnvs,
  deploy: deployKit,
  nothingToErase:
    "Kit owns no server data; a flashed device's token and its grant belong to the platform.",
};
if (process.argv[1]?.endsWith("app.ts")) void startAppCli(kit).run();
