import { isMainModule } from "@iterate-com/shared/dev/is-main-module";
import { docsEnvs } from "../../../envs.ts";
import { startAppCli } from "../../../scripts/lib/start-app.ts";

/** apps/docs as scripts/lib/start-app.ts sees it: the package scripts and vite.config.ts run off this. */
export const docs = {
  name: "docs",
  // Docs has no secrets of its own: its deploy reads the Cloudflare and CI tokens every app
  // inherits, straight from _shared
  dopplerProject: "_shared",
  root: new URL("..", import.meta.url),
  envs: docsEnvs,
};
if (isMainModule(import.meta.url)) void startAppCli(docs).run();
