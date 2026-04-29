import { experimental_RPCHandler as WebSocketRPCHandler } from "@orpc/server/crossws";
import { appRouter } from "./router";

export const wsRpcHandler = new WebSocketRPCHandler(appRouter, {});
