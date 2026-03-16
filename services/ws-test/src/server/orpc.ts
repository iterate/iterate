import type { Server as HttpServer, IncomingMessage } from "node:http";
import { WebSocketServer } from "ws";
import { createORPCClient } from "@orpc/client";
import { oc } from "@orpc/contract";
import { OpenAPILink } from "@orpc/openapi-client/fetch";
import { onError, implement, type RouterClient } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { RPCHandler as WebSocketRPCHandler } from "@orpc/server/ws";
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
  return createORPCClient(
    new OpenAPILink(contract, {
      url: new URL("/rpc", window.location.origin).toString(),
    }),
  );
}

export function attachOrpcWebSocketServer(server: HttpServer) {
  const wsHandler = new WebSocketRPCHandler(router, {
    interceptors: [
      onError((error) => {
        console.error(error);
      }),
    ],
  });
  const wss = new WebSocketServer({ noServer: true });

  wss.on("connection", (ws: any) => {
    void wsHandler.upgrade(ws, {
      context: {},
    });
  });

  const upgradeListener = (
    req: IncomingMessage,
    socket: import("node:stream").Duplex,
    head: Buffer,
  ) => {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    if (pathname !== "/orpc/ws") {
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws: any) => {
      wss.emit("connection", ws, req);
    });
  };

  server.on("upgrade", upgradeListener);

  return () => {
    server.off("upgrade", upgradeListener);
    wss.close();
  };
}
