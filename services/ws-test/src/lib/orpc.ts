import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import { createBrowserOrpcClient } from "@/server/orpc.ts";

export const orpcClient = createBrowserOrpcClient();
export const orpc = createTanstackQueryUtils(orpcClient);
