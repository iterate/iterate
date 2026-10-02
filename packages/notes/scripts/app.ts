import { notesEnvs } from "../../../envs.ts";
import { startAppCli } from "../../../scripts/lib/start-app.ts";

/** packages/notes as scripts/lib/start-app.ts sees it: the package scripts and vite.config.ts run off this. */
export const notes = {
  name: "notes",
  dopplerProject: "notes",
  root: new URL("..", import.meta.url),
  envs: notesEnvs,
};
if (import.meta.main) void startAppCli(notes).run();
