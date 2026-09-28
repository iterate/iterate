import handler, { createServerEntry } from "@tanstack/react-start/server-entry";
import { appServerEntry } from "@iterate-com/ui/apps/server";
import { adminScopes } from "./scopes.ts";
export { BrowserSession } from "iterate/app-session";

export default createServerEntry(
  appServerEntry(handler, {
    clientName: "iterate Admin",
    scopes: adminScopes,
    // routes/_auth/projects.index.tsx
    home: "/projects",
  }),
);
