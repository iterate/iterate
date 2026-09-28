import { createIterateClient } from "iterate/app";
import { dashScopes } from "./scopes.ts";

/** The Dash's one client (docs/frontend-development.md#get-a-handle): the signed-in shell
 *  (routes/_auth.tsx) and the collection link's page outside it (routes/collect-secret.$slug.tsx)
 *  authenticate through it, over the tab's one socket. */
export const iterateClient = createIterateClient({ scopes: dashScopes });
