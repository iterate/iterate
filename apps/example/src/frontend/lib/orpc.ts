import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import { createExampleClient } from "@/client.ts";

export const orpcClient = createExampleClient();
export const orpc = createTanstackQueryUtils(orpcClient);
