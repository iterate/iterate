import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { ContractRouterClient } from "@orpc/contract";
import { ordersContract } from "@jonasland5/orders-contract";

const DEFAULT_ORDERS_CLIENT_HOST = "127.0.0.1";
const DEFAULT_ORDERS_PORT = 19020;

export type OrdersClient = ContractRouterClient<typeof ordersContract>;

export function createOrdersClient(params?: {
  url?: string;
  fetch?: (request: Request) => Promise<Response>;
}): OrdersClient {
  const url =
    params?.url ?? `http://${DEFAULT_ORDERS_CLIENT_HOST}:${String(DEFAULT_ORDERS_PORT)}/orpc`;
  const link = new RPCLink({ url, ...(params?.fetch ? { fetch: params.fetch } : {}) });
  return createORPCClient(link);
}
