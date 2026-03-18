import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import { createWsTest2Client } from "@iterate-com/ws-test-2-contract";

export const orpcClient = createWsTest2Client();
export const orpc = createTanstackQueryUtils(orpcClient);
