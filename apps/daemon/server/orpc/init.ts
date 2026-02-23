import { AsyncLocalStorage } from "node:async_hooks";
import { os } from "@orpc/server";

const base = os.$context<Record<string, never>>();

export const publicProcedure = base;

/** Per-request log emitter. Set by /api/orpc-stream/*, read by execJs. */
export const logEmitterStorage = new AsyncLocalStorage<EventTarget>();
