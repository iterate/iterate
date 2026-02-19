import { AsyncLocalStorage } from "node:async_hooks";
import { initTRPC } from "@trpc/server";

const t = initTRPC.create();

export const createTRPCRouter = t.router;
export const mergeRouters = t.mergeRouters;
export const publicProcedure = t.procedure;

/** Per-request log emitter. Set by /api/trpc-stream/*, read by execJs. */
export const logEmitterStorage = new AsyncLocalStorage<EventTarget>();
