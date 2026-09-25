import { isMainModule } from "@iterate-com/shared/dev/is-main-module";
import { notesEnvs } from "../../../envs.ts";
import { startAppCli } from "../../../scripts/lib/start-app.ts";

/** apps/notes as scripts/lib/start-app.ts sees it: the package scripts and vite.config.ts run off this. */
export const notes = {
  name: "notes",
  root: new URL("..", import.meta.url),
  envs: notesEnvs,
};
if (isMainModule(import.meta.url)) void startAppCli(notes).run();
