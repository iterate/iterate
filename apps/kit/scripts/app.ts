import { kitEnvs } from "../../../envs.ts";
import { startAppCli } from "../../../scripts/lib/start-app.ts";

/** apps/kit as scripts/lib/start-app.ts sees it: the package scripts and vite.config.ts run off this. */
export const kit = {
  name: "kit",
  root: new URL("..", import.meta.url),
  envs: kitEnvs,
  nothingToErase:
    "Kit owns no server data; a flashed device's token and its grant belong to the platform.",
};
if (process.argv[1]?.endsWith("app.ts")) void startAppCli(kit).run();
