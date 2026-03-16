import type { WebSocket } from "ws";
import { createORPCClient } from "@orpc/client";
import { oc } from "@orpc/contract";
import { OpenAPILink } from "@orpc/openapi-client/fetch";
import { onError, implement, type RouterClient } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { z } from "zod";

const pingOutput = z.object({
  message: z.string(),
  serverTime: z.string(),
});

export const contract = oc.router({
  ping: oc
    .route({
      method: "GET",
      path: "/ping",
      summary: "Ping over oRPC HTTP",
      tags: ["debug"],
    })
    .input(z.object({}).optional().default({}))
    .output(pingOutput),
});

const os = implement(contract).$context<{}>();

export const router = os.router({
  ping: os.ping.handler(async () => ({
    message: "pong",
    serverTime: new Date().toISOString(),
  })),
});

export type OrpcRouter = typeof router;

export const httpRpcHandler = new RPCHandler(router, {
  interceptors: [
    onError((error) => {
      console.error(error);
    }),
  ],
});

export function createBrowserOrpcClient(): RouterClient<OrpcRouter> {
  const url =
    typeof window === "undefined"
      ? "http://127.0.0.1/api/rpc"
      : new URL("/api/rpc", window.location.origin).toString();
  return createORPCClient(
    new OpenAPILink(contract, {
      url,
    }),
  );
}

export type OrpcWebSocket = WebSocket;
