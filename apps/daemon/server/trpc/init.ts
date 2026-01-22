import { os } from "@orpc/server";

export const pub = os.$context<object>();
export const publicProcedure = pub;
