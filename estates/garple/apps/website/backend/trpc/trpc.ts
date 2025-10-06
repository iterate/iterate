import { initTRPC } from "@trpc/server";
import type { Context } from "hono";
import superjson from "superjson";
import type { CloudflareEnv } from "../../env.ts";
import type { AppRouter } from "./index.ts";

export type TrpcContext = { c: Context<{ Bindings: CloudflareEnv }> };
export type TrpcMeta = { description?: string };
export type Routers = { garple: AppRouter };

export function createContext(c: Context<{ Bindings: CloudflareEnv }>): TrpcContext {
  return { c };
}

const t = initTRPC.context<TrpcContext>().meta<TrpcMeta>().create({
  transformer: superjson,
});

export const createRouter = t.router;
export const publicProcedure = t.procedure;
