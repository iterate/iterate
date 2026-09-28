import handler, { createServerEntry } from "@tanstack/react-start/server-entry";
import { appServerEntry } from "@iterate-com/ui/apps/server";
export { BrowserSession } from "iterate/app-session";

export default createServerEntry(
  appServerEntry(handler, {
    clientName: "iterate Voice",
    // the phone: routes/_auth/projects.index.tsx opens the first project's page
    home: "/projects",
  }),
);
