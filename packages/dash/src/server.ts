import handler, { createServerEntry } from "@tanstack/react-start/server-entry";
import { appServerEntry } from "@iterate-com/ui/apps/server";
import { dashScopes } from "./lib/scopes.ts";
export { BrowserSession } from "iterate/app-session";

export default createServerEntry(
  appServerEntry(handler, {
    clientName: "iterate Dash",
    scopes: dashScopes,
    // routes/_auth/home.tsx: its only project, or the list
    home: "/home",
  }),
);
