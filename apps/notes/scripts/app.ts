import { notesEnvs } from "../../../envs.ts";
import { startAppCli } from "../../../scripts/lib/start-app.ts";

/** apps/notes as scripts/lib/start-app.ts sees it: the package scripts and vite.config.ts run off this. */
export const notes = {
  name: "notes",
  root: new URL("..", import.meta.url),
  envs: notesEnvs,
};
if (process.argv[1]?.endsWith("app.ts")) void startAppCli(notes).run();
