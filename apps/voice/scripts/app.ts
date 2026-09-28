import { isMainModule } from "@iterate-com/shared/dev/is-main-module";
import { voiceEnvs } from "../../../envs.ts";
import { startAppCli } from "../../../scripts/lib/start-app.ts";

/** apps/voice as scripts/lib/start-app.ts sees it: the package scripts and vite.config.ts run off this. */
export const voice = {
  name: "voice",
  root: new URL("..", import.meta.url),
  envs: voiceEnvs,
};
if (isMainModule(import.meta.url)) void startAppCli(voice).run();
