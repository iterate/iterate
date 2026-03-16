import { oc } from "@orpc/contract";
import { implement } from "@orpc/server";
import { z } from "zod";
import type { WsTest2Context } from "./context.ts";

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

const os = implement(contract).$context<WsTest2Context>();

export const router = os.router({
  ping: os.ping.handler(async () => ({
    message: "pong",
    serverTime: new Date().toISOString(),
  })),
});
