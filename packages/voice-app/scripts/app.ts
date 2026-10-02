import { voiceEnvs } from "../../../envs.ts";
import { startAppCli } from "../../../scripts/lib/start-app.ts";

/** packages/voice-app as scripts/lib/start-app.ts sees it: the package scripts and vite.config.ts run off this. */
export const voice = {
  name: "voice",
  dopplerProject: "voice",
  root: new URL("..", import.meta.url),
  envs: voiceEnvs,
};
if (import.meta.main) void startAppCli(voice).run();
