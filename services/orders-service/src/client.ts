import type { ContractRouterClient } from "@orpc/contract";
import { ordersContract, ordersServiceManifest } from "@iterate-com/orders-contract";
import { createOrpcRpcServiceClient } from "@iterate-com/shared/jonasland";

export type OrdersClient = ContractRouterClient<typeof ordersContract>;

export function createOrdersClient(params?: {
  url?: string;
  baseUrl?: string;
  fetch?: (request: Request) => Promise<Response>;
}): OrdersClient {
  return createOrpcRpcServiceClient({
    env: {
      ...(params?.baseUrl ? { ITERATE_PROJECT_BASE_URL: params.baseUrl } : {}),
    },
    manifest: ordersServiceManifest,
    ...(params?.url ? { url: params.url } : {}),
    ...(params?.fetch ? { fetch: params.fetch } : {}),
  });
}
