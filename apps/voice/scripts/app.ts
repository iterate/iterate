import { voiceEnvs } from "../../../envs.ts";
import { startAppCli } from "../../../scripts/lib/start-app.ts";

/** apps/voice as scripts/lib/start-app.ts sees it: the package scripts and vite.config.ts run off this. */
export const voice = {
  name: "voice",
  root: new URL("..", import.meta.url),
  envs: voiceEnvs,
};
if (process.argv[1]?.endsWith("app.ts")) void startAppCli(voice).run();
