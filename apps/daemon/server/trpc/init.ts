import { initTRPC } from "@trpc/server";

const t = initTRPC.create();

export const createTRPCRouter = t.router;
export const mergeRouters = t.mergeRouters;
export const publicProcedure = t.procedure;
